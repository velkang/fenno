import { getAddress, type Hex } from "viem";
import type {
  MainnetAttempt,
  MainnetAttemptStatus,
  MainnetReplacementStore,
  ReconciliationOutcome,
} from "./mainnet-reconciler";

type AttemptRow = {
  attempt_id: string;
  intent_id: string;
  wallet_id: string;
  wallet_address: string;
  nonce: number;
  transaction_hash: Hex;
  status: MainnetAttemptStatus;
  submitted_at: number;
  missing_observations: number;
  block_number: number | null;
  final_reason: string | null;
};

function fromRow(row: AttemptRow): MainnetAttempt {
  return {
    attemptId: row.attempt_id,
    intentId: row.intent_id,
    walletId: row.wallet_id,
    walletAddress: getAddress(row.wallet_address),
    nonce: row.nonce,
    transactionHash: row.transaction_hash,
    status: row.status,
    submittedAt: row.submitted_at,
    missingObservations: row.missing_observations,
    blockNumber: row.block_number,
    finalReason: row.final_reason,
  };
}

export class D1MainnetReconciliationStore implements MainnetReplacementStore {
  constructor(private readonly db: D1Database) {}

  async load(attemptId: string): Promise<MainnetAttempt | null> {
    const row = await this.db.prepare(
      `SELECT mta.id AS attempt_id, mta.intent_id, mta.wallet_id,
              mw.address AS wallet_address, mta.nonce, mta.transaction_hash,
              mta.status, mta.submitted_at, mta.missing_observations,
              mta.block_number, mta.final_reason
       FROM mainnet_transaction_attempts mta
       JOIN managed_wallets mw ON mw.id = mta.wallet_id
       WHERE mta.id = ?1`,
    ).bind(attemptId).first<AttemptRow>();
    return row ? fromRow(row) : null;
  }

  async observe(input: {
    attempt: MainnetAttempt;
    outcome: ReconciliationOutcome;
    reasonCode: string;
    latestNonce: number | null;
    pendingNonce: number | null;
    blockNumber: number | null;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE mainnet_transaction_attempts SET
           last_checked_at = ?2,
           missing_observations = CASE
             WHEN ?3 = 'TRANSACTION_NOT_FOUND' THEN missing_observations + 1
             ELSE 0
           END
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(input.attempt.attemptId, input.now, input.reasonCode),
      this.reconciliationStatement(input),
    ]);
  }

  async finalize(input: {
    attempt: MainnetAttempt;
    attemptStatus: Exclude<MainnetAttemptStatus, "submitted" | "replaced">;
    intentStatus: "confirmed" | "failed";
    reasonCode: string;
    blockNumber: number | null;
    latestNonce: number | null;
    pendingNonce: number | null;
    quarantineWallet: boolean;
    v4TokenId?: string | null;
    now: number;
  }): Promise<void> {
    const outcome = input.attemptStatus === "confirmed"
      ? "confirmed"
      : input.attemptStatus === "reverted"
        ? "reverted"
        : input.attemptStatus === "dropped"
          ? "dropped"
          : "nonce_conflict";
    const statements = [
      this.db.prepare(
        `UPDATE mainnet_transaction_attempts SET
           status = ?2, last_checked_at = ?3, block_number = ?4,
           final_reason = ?5
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(
        input.attempt.attemptId,
        input.attemptStatus,
        input.now,
        input.blockNumber,
        input.reasonCode,
      ),
      this.db.prepare(
        `UPDATE wallet_intents SET
           status = ?2, transaction_hash = ?3, block_number = ?4,
           failure_reason = ?5, updated_at = ?6
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(
        input.attempt.intentId,
        input.intentStatus,
        input.attempt.transactionHash,
        input.blockNumber,
        input.intentStatus === "failed" ? input.reasonCode : null,
        input.now,
      ),
      this.db.prepare(
        `UPDATE wallet_execution_state SET
           state = 'idle', active_intent_id = NULL, active_nonce = NULL,
           lease_expires_at = NULL, updated_at = ?4
         WHERE wallet_id = ?1 AND active_intent_id = ?2
           AND active_nonce = ?3 AND state = 'submitted'`,
      ).bind(
        input.attempt.walletId,
        input.attempt.intentId,
        input.attempt.nonce,
        input.now,
      ),
      this.reconciliationStatement({
        attempt: input.attempt,
        outcome,
        reasonCode: input.reasonCode,
        latestNonce: input.latestNonce,
        pendingNonce: input.pendingNonce,
        blockNumber: input.blockNumber,
        now: input.now,
      }),
    ];
    if (input.v4TokenId) {
      statements.push(
        this.db.prepare(
          `UPDATE v4_mint_intents SET token_id = ?2
           WHERE intent_id = ?1 AND token_id IS NULL`,
        ).bind(input.attempt.intentId, input.v4TokenId),
      );
    }
    if (input.quarantineWallet) {
      statements.push(
        this.db.prepare(
          `UPDATE managed_wallets SET state = 'quarantined', updated_at = ?2
           WHERE id = ?1 AND state <> 'closed'`,
        ).bind(input.attempt.walletId, input.now),
      );
    }
    await this.db.batch(statements);
  }

  async replace(input: {
    attempt: MainnetAttempt;
    replacementAttemptId: string;
    replacementHash: Hex;
    now: number;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE mainnet_transaction_attempts SET
           status = 'replaced', last_checked_at = ?2,
           final_reason = 'REPLACED_BY_FEE_BUMP'
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(input.attempt.attemptId, input.now),
      this.db.prepare(
        `INSERT INTO mainnet_transaction_attempts (
           id, intent_id, wallet_id, nonce, transaction_hash,
           replaces_attempt_id, status, submitted_at
         )
         SELECT ?2, intent_id, wallet_id, nonce, ?3, id, 'submitted', ?4
         FROM mainnet_transaction_attempts
         WHERE id = ?1 AND status = 'replaced'`,
      ).bind(
        input.attempt.attemptId,
        input.replacementAttemptId,
        input.replacementHash,
        input.now,
      ),
      this.db.prepare(
        `UPDATE wallet_intents SET transaction_hash = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(input.attempt.intentId, input.replacementHash, input.now),
    ]);
    return results[0].meta.changes === 1 && results[1].meta.changes === 1;
  }

  private reconciliationStatement(input: {
    attempt: MainnetAttempt;
    outcome: ReconciliationOutcome;
    reasonCode: string;
    latestNonce: number | null;
    pendingNonce: number | null;
    blockNumber: number | null;
    now: number;
  }): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO mainnet_transaction_reconciliations (
         id, attempt_id, outcome, reason_code, latest_nonce,
         pending_nonce, block_number, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      `reconciliation_${crypto.randomUUID()}`,
      input.attempt.attemptId,
      input.outcome,
      input.reasonCode,
      input.latestNonce,
      input.pendingNonce,
      input.blockNumber,
      input.now,
    );
  }
}
