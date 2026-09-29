import type { Address } from "viem";
import type { AuthChallenge, AuthStore, AuthUser, Invitation } from "./auth";

type UserRow = { id: string; owner_address: Address };
type ChallengeRow = {
  id: string;
  user_id: string | null;
  invitation_id: string | null;
  owner_address: Address;
  nonce: string;
  message: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
};

function userFromRow(row: UserRow): AuthUser {
  return { id: row.id, ownerAddress: row.owner_address };
}

function challengeFromRow(row: ChallengeRow): AuthChallenge {
  return {
    id: row.id,
    userId: row.user_id,
    invitationId: row.invitation_id,
    ownerAddress: row.owner_address,
    nonce: row.nonce,
    message: row.message,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export class D1AuthStore implements AuthStore {
  constructor(private readonly database: D1Database) {}

  async findUserByOwnerAddress(address: Address): Promise<AuthUser | null> {
    const row = await this.database
      .prepare("SELECT id, owner_address FROM users WHERE owner_address = ?1")
      .bind(address)
      .first<UserRow>();
    return row ? userFromRow(row) : null;
  }

  async findAvailableInvitation(
    codeHash: string,
    now: number,
  ): Promise<Invitation | null> {
    const row = await this.database
      .prepare(
        `SELECT id FROM invitations
         WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
      )
      .bind(codeHash, now)
      .first<{ id: string }>();
    return row ?? null;
  }

  async createChallenge(challenge: AuthChallenge): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO auth_challenges (
          id, user_id, invitation_id, owner_address, nonce, message,
          expires_at, used_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        challenge.id,
        challenge.userId,
        challenge.invitationId,
        challenge.ownerAddress,
        challenge.nonce,
        challenge.message,
        challenge.expiresAt,
        challenge.usedAt,
        challenge.createdAt,
      )
      .run();
  }

  async getChallenge(id: string): Promise<AuthChallenge | null> {
    const row = await this.database
      .prepare("SELECT * FROM auth_challenges WHERE id = ?1")
      .bind(id)
      .first<ChallengeRow>();
    return row ? challengeFromRow(row) : null;
  }

  async consumeChallenge(id: string, now: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE auth_challenges SET used_at = ?2
         WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2`,
      )
      .bind(id, now)
      .run();
    return result.meta.changes === 1;
  }

  async createInvitedUser(input: {
    id: string;
    ownerAddress: Address;
    invitationId: string;
    now: number;
  }): Promise<AuthUser | null> {
    const [inserted] = await this.database.batch([
      this.database.prepare(
        `INSERT INTO users (
          id, owner_address, owner_verified_at, created_at, invitation_id
        )
        SELECT ?1, ?2, ?3, ?3, id FROM invitations
        WHERE id = ?4 AND used_at IS NULL AND expires_at > ?3`,
      )
        .bind(input.id, input.ownerAddress, input.now, input.invitationId),
      this.database
        .prepare(
          `UPDATE invitations SET used_by_user_id = ?2, used_at = ?3
           WHERE id = ?1 AND used_at IS NULL
             AND EXISTS (
               SELECT 1 FROM users
               WHERE id = ?2 AND invitation_id = ?1
             )`,
        )
        .bind(input.invitationId, input.id, input.now),
    ]);
    if (inserted.meta.changes !== 1) return null;
    return { id: input.id, ownerAddress: input.ownerAddress };
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    challengeId: string;
    expiresAt: number;
    createdAt: number;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO auth_sessions (
          token_hash, user_id, challenge_id, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        input.tokenHash,
        input.userId,
        input.challengeId,
        input.expiresAt,
        input.createdAt,
      )
      .run();
  }

  async findSessionUser(tokenHash: string, now: number): Promise<AuthUser | null> {
    const row = await this.database
      .prepare(
        `SELECT users.id, users.owner_address
         FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
         WHERE auth_sessions.token_hash = ?1 AND auth_sessions.expires_at > ?2`,
      )
      .bind(tokenHash, now)
      .first<UserRow>();
    return row ? userFromRow(row) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM auth_sessions WHERE token_hash = ?1")
      .bind(tokenHash)
      .run();
  }
}
