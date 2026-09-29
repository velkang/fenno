import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import {
  createSiweMessage,
  type CreateSiweMessageParameters,
} from "viem/siwe";

const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type AuthUser = { id: string; ownerAddress: Address };
export type Invitation = { id: string };

export type AuthChallenge = {
  id: string;
  userId: string | null;
  invitationId: string | null;
  ownerAddress: Address;
  nonce: string;
  message: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
};

export interface AuthStore {
  findUserByOwnerAddress(address: Address): Promise<AuthUser | null>;
  findAvailableInvitation(
    codeHash: string,
    now: number,
  ): Promise<Invitation | null>;
  createChallenge(challenge: AuthChallenge): Promise<void>;
  getChallenge(id: string): Promise<AuthChallenge | null>;
  consumeChallenge(id: string, now: number): Promise<boolean>;
  createInvitedUser(input: {
    id: string;
    ownerAddress: Address;
    invitationId: string;
    now: number;
  }): Promise<AuthUser | null>;
  createSession(input: {
    tokenHash: string;
    userId: string;
    challengeId: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void>;
  findSessionUser(tokenHash: string, now: number): Promise<AuthUser | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

type AuthConfig = { chainId: number; domain: string; uri: string };
type AuthDependencies = {
  now?: () => number;
  randomId?: () => string;
  randomToken?: () => string;
  verifySignature?: (input: {
    address: Address;
    message: string;
    signature: Hex;
  }) => Promise<boolean>;
};

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashOpaqueValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function normalizeOwnerAddress(value: unknown): Address {
  if (typeof value !== "string") {
    throw new AuthError("INVALID_ADDRESS", 400);
  }
  try {
    return getAddress(value);
  } catch {
    throw new AuthError("INVALID_ADDRESS", 400);
  }
}

export async function issueChallenge(
  store: AuthStore,
  input: { address: unknown; invitationCode?: unknown },
  config: AuthConfig,
  dependencies: AuthDependencies = {},
): Promise<{ challengeId: string; message: string; expiresAt: number }> {
  const ownerAddress = normalizeOwnerAddress(input.address);
  const now = dependencies.now?.() ?? Date.now();
  const user = await store.findUserByOwnerAddress(ownerAddress);
  let invitation: Invitation | null = null;

  if (!user) {
    if (
      typeof input.invitationCode !== "string" ||
      input.invitationCode.length < 8 ||
      input.invitationCode.length > 128
    ) {
      throw new AuthError("INVITATION_REQUIRED", 403);
    }
    invitation = await store.findAvailableInvitation(
      await hashOpaqueValue(input.invitationCode),
      now,
    );
    if (!invitation) throw new AuthError("INVALID_INVITATION", 403);
  }

  const nonce = randomHex(16);
  const expiresAt = now + CHALLENGE_TTL_MS;
  const siwe: CreateSiweMessageParameters = {
    address: ownerAddress,
    chainId: config.chainId,
    domain: config.domain,
    uri: config.uri,
    version: "1",
    nonce,
    statement: "Sign in to the Stillwater private alpha.",
    issuedAt: new Date(now),
    expirationTime: new Date(expiresAt),
  };
  const message = createSiweMessage(siwe);
  const challengeId = dependencies.randomId?.() ?? crypto.randomUUID();

  await store.createChallenge({
    id: challengeId,
    userId: user?.id ?? null,
    invitationId: invitation?.id ?? null,
    ownerAddress,
    nonce,
    message,
    expiresAt,
    usedAt: null,
    createdAt: now,
  });

  return { challengeId, message, expiresAt };
}

export async function verifyChallenge(
  store: AuthStore,
  input: { challengeId: unknown; message: unknown; signature: unknown },
  dependencies: AuthDependencies = {},
): Promise<{
  user: AuthUser;
  sessionToken: string;
  sessionExpiresAt: number;
}> {
  if (
    typeof input.challengeId !== "string" ||
    typeof input.message !== "string" ||
    typeof input.signature !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(input.signature)
  ) {
    throw new AuthError("INVALID_REQUEST", 400);
  }

  const now = dependencies.now?.() ?? Date.now();
  const challenge = await store.getChallenge(input.challengeId);
  if (!challenge) throw new AuthError("CHALLENGE_NOT_FOUND", 401);
  if (challenge.usedAt !== null) throw new AuthError("CHALLENGE_USED", 409);
  if (challenge.expiresAt <= now) throw new AuthError("CHALLENGE_EXPIRED", 401);
  if (input.message !== challenge.message) {
    throw new AuthError("INVALID_CHALLENGE_MESSAGE", 401);
  }

  let valid = false;
  try {
    valid = await (dependencies.verifySignature ?? verifyMessage)({
      address: challenge.ownerAddress,
      message: challenge.message,
      signature: input.signature as Hex,
    });
  } catch {
    valid = false;
  }
  if (!valid) throw new AuthError("INVALID_SIGNATURE", 401);
  if (!(await store.consumeChallenge(challenge.id, now))) {
    throw new AuthError("CHALLENGE_USED", 409);
  }

  let user = await store.findUserByOwnerAddress(challenge.ownerAddress);
  if (!user) {
    if (!challenge.invitationId) throw new AuthError("REGISTRATION_FAILED", 409);
    user = await store.createInvitedUser({
      id: dependencies.randomId?.() ?? crypto.randomUUID(),
      ownerAddress: challenge.ownerAddress,
      invitationId: challenge.invitationId,
      now,
    });
    if (!user) throw new AuthError("INVITATION_ALREADY_USED", 409);
  }

  const sessionToken = dependencies.randomToken?.() ?? randomToken();
  const sessionExpiresAt = now + SESSION_TTL_MS;
  await store.createSession({
    tokenHash: await hashOpaqueValue(sessionToken),
    userId: user.id,
    challengeId: challenge.id,
    expiresAt: sessionExpiresAt,
    createdAt: now,
  });

  return { user, sessionToken, sessionExpiresAt };
}
