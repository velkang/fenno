import { getAddress } from "viem";
import type {
  ExecutionRehearsal,
  ExecutionRehearsalStore,
  RehearsalWallet,
} from "./mainnet-rehearsal";

export class D1MainnetRehearsalStore implements ExecutionRehearsalStore {
  constructor(private readonly db: D1Database) {}

  async getWallet(intentId: string): Promise<RehearsalWallet | null> {
    const row = await this.db.prepare(
      `SELECT mw.id AS wallet_id, mw.address
       FROM wallet_intents wi
       JOIN managed_wallets mw ON mw.id = wi.wallet_id
       WHERE wi.id = ?1`,
    ).bind(intentId).first<{ wallet_id: string; address: string }>();
    return row
      ? { walletId: row.wallet_id, address: getAddress(row.address) }
      : null;
  }

  async reserve(input: {
    intentId: string;
    walletId: string;
    nonce: number;
    now: number;
    leaseExpiresAt: number;
  }): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO wallet_execution_state (
        wallet_id, state, active_intent_id, active_nonce, lease_expires_at,
        last_observed_pending_nonce, updated_at
      )
      SELECT ?2, 'reserved', ?1, ?3, ?5, ?3, ?4
      FROM wallet_intents
      WHERE id = ?1 AND wallet_id = ?2 AND status = 'pending'
      ON CONFLICT(wallet_id) DO UPDATE SET
        state = 'reserved', active_intent_id = excluded.active_intent_id,
        active_nonce = excluded.active_nonce,
        lease_expires_at = excluded.lease_expires_at,
        last_observed_pending_nonce = excluded.last_observed_pending_nonce,
        updated_at = excluded.updated_at
      WHERE wallet_execution_state.state = 'idle'
         OR (wallet_execution_state.state = 'reserved'
             AND wallet_execution_state.lease_expires_at <= ?4)`,
    ).bind(
      input.intentId,
      input.walletId,
      input.nonce,
      input.now,
      input.leaseExpiresAt,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async release(input: {
    intentId: string;
    walletId: string;
    nonce: number;
    now: number;
  }): Promise<void> {
    await this.db.prepare(
      `UPDATE wallet_execution_state SET
        state = 'idle', active_intent_id = NULL, active_nonce = NULL,
        lease_expires_at = NULL, updated_at = ?4
       WHERE wallet_id = ?2 AND active_intent_id = ?1
         AND active_nonce = ?3 AND state = 'reserved'`,
    ).bind(input.intentId, input.walletId, input.nonce, input.now).run();
  }

  async save(value: ExecutionRehearsal): Promise<void> {
    await this.db.prepare(
      `INSERT INTO mainnet_execution_rehearsals (
        id, intent_id, wallet_id, decision, reason_code,
        observed_pending_nonce, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      `rehearsal_${crypto.randomUUID()}`,
      value.intentId,
      value.walletId,
      value.decision,
      value.reasonCode,
      value.observedPendingNonce,
      value.createdAt,
    ).run();
  }
}
