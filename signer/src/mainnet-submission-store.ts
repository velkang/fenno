import type { MainnetSubmission, MainnetSubmissionStore } from "./mainnet-submission";

type ReservationRow = {
  intent_id: string;
  wallet_id: string;
  nonce: number;
  lease_expires_at: number;
  intent_status: string;
  intent_expires_at: number;
};

export class D1MainnetSubmissionStore implements MainnetSubmissionStore {
  constructor(private readonly db: D1Database) {}

  async loadReservation(intentId: string) {
    const row = await this.db.prepare(
      `SELECT wi.id AS intent_id, wi.wallet_id, wi.status AS intent_status,
              wi.expires_at AS intent_expires_at,
              wes.active_nonce AS nonce, wes.lease_expires_at
       FROM wallet_intents wi
       JOIN wallet_execution_state wes ON wes.wallet_id = wi.wallet_id
       WHERE wi.id = ?1 AND wes.state = 'reserved'
         AND wes.active_intent_id = wi.id`,
    ).bind(intentId).first<ReservationRow>();
    return row ? {
      intentId: row.intent_id,
      walletId: row.wallet_id,
      nonce: row.nonce,
      leaseExpiresAt: row.lease_expires_at,
      intentStatus: row.intent_status,
      intentExpiresAt: row.intent_expires_at,
    } : null;
  }

  async commit(input: MainnetSubmission): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO mainnet_transaction_attempts (
           id, intent_id, wallet_id, nonce, transaction_hash, status, submitted_at
         )
         SELECT ?1, wi.id, wi.wallet_id, wes.active_nonce, ?4, 'submitted', ?5
         FROM wallet_intents wi
         JOIN wallet_execution_state wes ON wes.wallet_id = wi.wallet_id
         WHERE wi.id = ?2 AND wi.wallet_id = ?3 AND wi.status = 'pending'
           AND wi.transaction_hash IS NULL AND wi.expires_at > ?5
           AND wes.state = 'reserved' AND wes.active_intent_id = wi.id
           AND wes.active_nonce = ?6 AND wes.lease_expires_at > ?5`,
      ).bind(
        input.attemptId,
        input.intentId,
        input.walletId,
        input.transactionHash,
        input.submittedAt,
        input.nonce,
      ),
      this.db.prepare(
        `UPDATE wallet_intents SET
           status = 'submitted', transaction_hash = ?2, updated_at = ?3
         WHERE id = ?1 AND wallet_id = ?4 AND status = 'pending'
           AND transaction_hash IS NULL
           AND EXISTS (
             SELECT 1 FROM mainnet_transaction_attempts
             WHERE id = ?5 AND intent_id = ?1 AND nonce = ?6
           )`,
      ).bind(
        input.intentId,
        input.transactionHash,
        input.submittedAt,
        input.walletId,
        input.attemptId,
        input.nonce,
      ),
      this.db.prepare(
        `UPDATE wallet_execution_state SET
           state = 'submitted', lease_expires_at = NULL, updated_at = ?4
         WHERE wallet_id = ?1 AND state = 'reserved'
           AND active_intent_id = ?2 AND active_nonce = ?3
           AND EXISTS (
             SELECT 1 FROM mainnet_transaction_attempts
             WHERE id = ?5 AND intent_id = ?2 AND nonce = ?3
           )`,
      ).bind(
        input.walletId,
        input.intentId,
        input.nonce,
        input.submittedAt,
        input.attemptId,
      ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }
}
