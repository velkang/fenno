import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AuthChallenge,
  type AuthStore,
  type AuthUser,
} from "../src/auth";
import { createApp, type Bindings } from "../src";

class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, AuthUser>();
  readonly challenges = new Map<string, AuthChallenge>();
  readonly sessions = new Map<
    string,
    { userId: string; challengeId: string; expiresAt: number }
  >();

  async findUserByOwnerAddress(address: Address) {
    return this.users.get(address.toLowerCase()) ?? null;
  }

  async createChallenge(challenge: AuthChallenge) {
    this.challenges.set(challenge.id, challenge);
  }

  async getChallenge(id: string) {
    return this.challenges.get(id) ?? null;
  }

  async consumeChallenge(id: string, now: number) {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.usedAt !== null || challenge.expiresAt <= now) {
      return false;
    }
    challenge.usedAt = now;
    return true;
  }

  async createUser(input: { id: string; ownerAddress: Address; now: number }) {
    const key = input.ownerAddress.toLowerCase();
    if (!this.users.has(key)) {
      this.users.set(key, { id: input.id, ownerAddress: input.ownerAddress });
    }
    return this.users.get(key) ?? null;
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    challengeId: string;
    expiresAt: number;
  }) {
    if (
      [...this.sessions.values()].some(
        (session) => session.challengeId === input.challengeId,
      )
    ) {
      throw new Error("duplicate challenge session");
    }
    this.sessions.set(input.tokenHash, input);
  }

  async findSessionUser(tokenHash: string, now: number) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= now) return null;
    return (
      [...this.users.values()].find((user) => user.id === session.userId) ?? null
    );
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
}

const account = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const startedAt = Date.UTC(2026, 8, 18, 12);

describe("private-alpha authentication", () => {
  let now: number;
  let store: MemoryAuthStore;
  let signerRequests: Array<{ userId: string; walletId: string }>;
  let env: Bindings;

  beforeEach(async () => {
    now = startedAt;
    store = new MemoryAuthStore();
    signerRequests = [];
    env = {
      DB: {} as D1Database,
      AUTH_URI: "http://localhost:8787",
      AUTH_COOKIE_SECURE: "false",
      ARC_RPC_URL: "https://rpc.mainnet.arc.io",
      SIGNER: {
        fetch: async (request: Request) => {
          const body = (await request.json()) as {
            userId: string;
            walletId: string;
          };
          signerRequests.push(body);
          return Response.json(
            {
              walletId: body.walletId,
              address: "0x0000000000000000000000000000000000000001",
              created: signerRequests.length === 1,
            },
            { status: signerRequests.length === 1 ? 201 : 200 },
          );
        },
        connect: () => {
          throw new Error("not implemented");
        },
      },
    };
  });

  it("signs up a new owner wallet with only its signature and issues a hashed session", async () => {
    const app = createApp({ createAuthStore: () => store, now: () => now });
    const challengeResponse = await app.request(
      "/v1/auth/challenge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      },
      env,
    );
    expect(challengeResponse.status).toBe(201);
    const challenge = await challengeResponse.json<{
      challengeId: string;
      message: string;
    }>();
    const signature = await account.signMessage({ message: challenge.message });

    const verifyResponse = await app.request(
      "/v1/auth/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...challenge, signature }),
      },
      env,
    );
    expect(verifyResponse.status).toBe(200);
    const setCookie = verifyResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("stillwater_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    expect(store.sessions.size).toBe(1);
    expect([...store.sessions.keys()][0]).toMatch(/^[0-9a-f]{64}$/);

    const cookie = setCookie.split(";")[0];
    const meResponse = await app.request(
      "/v1/me",
      { headers: { cookie } },
      env,
    );
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toEqual({
      user: { id: expect.any(String), ownerAddress: account.address },
    });

    const firstProvision = await app.request(
      "/v1/wallets/provision",
      { method: "POST", headers: { cookie } },
      env,
    );
    const secondProvision = await app.request(
      "/v1/wallets/provision",
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(firstProvision.status).toBe(201);
    expect(secondProvision.status).toBe(200);
    expect(signerRequests).toHaveLength(2);
    expect(signerRequests[0]).toEqual(signerRequests[1]);
    expect(signerRequests[0].walletId).toBe(
      `wallet_${signerRequests[0].userId}`,
    );

    const replay = await app.request(
      "/v1/auth/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...challenge, signature }),
      },
      env,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "CHALLENGE_USED" });
  });

  it("reuses the existing user when the same wallet signs in again", async () => {
    const app = createApp({ createAuthStore: () => store, now: () => now });
    const signIn = async () => {
      const challengeResponse = await app.request(
        "/v1/auth/challenge",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: account.address }),
        },
        env,
      );
      const challenge = await challengeResponse.json<{ challengeId: string; message: string }>();
      const signature = await account.signMessage({ message: challenge.message });
      const response = await app.request(
        "/v1/auth/verify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...challenge, signature }),
        },
        env,
      );
      expect(response.status).toBe(200);
      return (await response.json<{ user: AuthUser }>()).user.id;
    };

    const firstUserId = await signIn();
    expect(await signIn()).toBe(firstUserId);
    expect(store.users.size).toBe(1);
    expect(store.sessions.size).toBe(2);
  });

  it("rejects expired challenges", async () => {
    const app = createApp({ createAuthStore: () => store, now: () => now });
    const challengeResponse = await app.request(
      "/v1/auth/challenge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      },
      env,
    );
    const challenge = await challengeResponse.json<{
      challengeId: string;
      message: string;
    }>();
    const signature = await account.signMessage({ message: challenge.message });
    now += 5 * 60 * 1_000 + 1;

    const response = await app.request(
      "/v1/auth/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...challenge, signature }),
      },
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "CHALLENGE_EXPIRED" });
  });

  it("rejects wallet provisioning without a session", async () => {
    const app = createApp({ createAuthStore: () => store, now: () => now });
    const response = await app.request(
      "/v1/wallets/provision",
      { method: "POST" },
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(signerRequests).toHaveLength(0);
  });
});
