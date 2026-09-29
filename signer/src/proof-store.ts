import type { Address, Hex } from "viem";
import type { WalletState } from "./policy";
import type {
  ProofExecution,
  ProofIntentStatus,
  ProofStore,
} from "./proof";

type ProofRow = {
  intent_id: string;
  intent_kind: string;
  intent_status: ProofIntentStatus;
  intent_expires_at: number;
  payload_hash: Hex;
  transaction_hash: Hex | null;
  attempt_id: string | null;
  wallet_id: string;
  wallet_address: Address;
  wallet_state: WalletState;
  key_version: number;
  ciphertext: string;
  ciphertext_iv: string;
  wrapped_data_key: string;
  wrapped_data_key_iv: string;
  owner_address: Address;
};

function fromRow(row: ProofRow): ProofExecution {
  return {
    intentId: row.intent_id,
    intentKind: row.intent_kind,
    intentStatus: row.intent_status,
    intentExpiresAt: row.intent_expires_at,
    payloadHash: row.payload_hash,
    transactionHash: row.transaction_hash,
    attemptId: row.attempt_id,
    wallet: {
      walletId: row.wallet_id,
      address: row.wallet_address,
      keyVersion: row.key_version,
      ciphertext: row.ciphertext,
      ciphertextIv: row.ciphertext_iv,
      wrappedDataKey: row.wrapped_data_key,
      wrappedDataKeyIv: row.wrapped_data_key_iv,
    },
    walletState: row.wallet_state,
    verifiedOwnerAddress: row.owner_address,
  };
}

export class D1ProofStore implements ProofStore {
  constructor(private readonly database: D1Database) {}

  async getExecution(intentId: string, walletId: string) {
    const row = await this.database
      .prepare(
        `SELECT
          wallet_intents.id AS intent_id,
          wallet_intents.kind AS intent_kind,
          wallet_intents.status AS intent_status,
          wallet_intents.expires_at AS intent_expires_at,
          wallet_intents.payload_hash,
          wallet_intents.transaction_hash,
          testnet_transaction_attempts.id AS attempt_id,
          managed_wallets.id AS wallet_id,
          managed_wallets.address AS wallet_address,
          managed_wallets.state AS wallet_state,
          managed_wallets.key_version,
          managed_wallets.ciphertext,
          managed_wallets.ciphertext_iv,
          managed_wallets.wrapped_data_key,
          managed_wallets.wrapped_data_key_iv,
          users.owner_address
        FROM wallet_intents
        JOIN managed_wallets ON managed_wallets.id = wallet_intents.wallet_id
        JOIN users ON users.id = managed_wallets.user_id
        LEFT JOIN testnet_transaction_attempts
          ON testnet_transaction_attempts.intent_id = wallet_intents.id
         AND testnet_transaction_attempts.status = 'submitted'
        WHERE wallet_intents.id = ?1 AND managed_wallets.id = ?2`,
      )
      .bind(intentId, walletId)
      .first<ProofRow>();
    return row ? fromRow(row) : null;
  }

  async reserveNonce(input: {
    execution: ProofExecution;
    nonce: number;
    now: number;
    leaseExpiresAt: number;
  }) {
    const result = await this.database.prepare(
      `INSERT INTO wallet_execution_state (
         wallet_id, state, active_intent_id, active_nonce, lease_expires_at,
         last_observed_pending_nonce, updated_at
       )
       SELECT ?2, 'reserved', ?1, ?3, ?5, ?3, ?4
       FROM wallet_intents
       WHERE id = ?1 AND wallet_id = ?2 AND status = 'pending'
         AND expires_at > ?4
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
      input.execution.intentId,
      input.execution.wallet.walletId,
      input.nonce,
      input.now,
      input.leaseExpiresAt,
    ).run();
    return result.meta.changes === 1;
  }

  async handoffSubmitted(input: {
    execution: ProofExecution;
    attemptId: string;
    nonce: number;
    transactionHash: Hex;
    now: number;
  }) {
    const results = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO testnet_transaction_attempts (
             id, intent_id, wallet_id, nonce, transaction_hash,
             status, submitted_at, updated_at
           )
           SELECT ?1, wi.id, wi.wallet_id, wes.active_nonce, ?4,
                  'submitted', ?5, ?5
           FROM wallet_intents wi
           JOIN wallet_execution_state wes ON wes.wallet_id = wi.wallet_id
           WHERE wi.id = ?2 AND wi.wallet_id = ?3 AND wi.status = 'pending'
             AND wi.transaction_hash IS NULL AND wi.expires_at > ?5
             AND wes.state = 'reserved' AND wes.active_intent_id = wi.id
             AND wes.active_nonce = ?6 AND wes.lease_expires_at > ?5
           ON CONFLICT(id) DO UPDATE SET
             nonce = excluded.nonce,
             transaction_hash = excluded.transaction_hash,
             status = 'submitted', submitted_at = excluded.submitted_at,
             block_number = NULL, final_reason = NULL,
             updated_at = excluded.updated_at
           WHERE testnet_transaction_attempts.intent_id = excluded.intent_id
             AND testnet_transaction_attempts.wallet_id = excluded.wallet_id
             AND testnet_transaction_attempts.status = 'broadcast_failed'`,
        )
        .bind(
          input.attemptId,
          input.execution.intentId,
          input.execution.wallet.walletId,
          input.transactionHash,
          input.now,
          input.nonce,
        ),
      this.database
        .prepare(
          `UPDATE wallet_intents
           SET status = 'submitted', transaction_hash = ?2, updated_at = ?3
           WHERE id = ?1 AND status = 'pending'
             AND EXISTS (
               SELECT 1 FROM testnet_transaction_attempts
               WHERE id = ?4 AND intent_id = ?1 AND nonce = ?5
             )`,
        )
        .bind(
          input.execution.intentId,
          input.transactionHash,
          input.now,
          input.attemptId,
          input.nonce,
        ),
      this.database
        .prepare(
          `UPDATE wallet_execution_state SET
             state = 'submitted', lease_expires_at = NULL, updated_at = ?4
           WHERE wallet_id = ?1 AND active_intent_id = ?2
             AND active_nonce = ?3 AND state = 'reserved'
             AND EXISTS (
               SELECT 1 FROM testnet_transaction_attempts
               WHERE id = ?5 AND intent_id = ?2 AND nonce = ?3
             )`,
        )
        .bind(
          input.execution.wallet.walletId,
          input.execution.intentId,
          input.nonce,
          input.now,
          input.attemptId,
        ),
      this.database
        .prepare(
          `INSERT INTO signing_audit_log (
            id, intent_id, wallet_id, decision, reason_code, chain_id,
            target_address, selector, transaction_hash, created_at
          )
          SELECT ?1, ?2, ?3, 'approved', 'POLICY_ALLOWED', 5042002,
                 ?4, '0x', ?5, ?6
          WHERE EXISTS (
            SELECT 1 FROM testnet_transaction_attempts
            WHERE id = ?7 AND intent_id = ?2
          )`,
        )
        .bind(
          crypto.randomUUID(),
          input.execution.intentId,
          input.execution.wallet.walletId,
          input.execution.wallet.address,
          input.transactionHash,
          input.now,
          input.attemptId,
        ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  async markFinal(input: {
    attemptId: string | null;
    intentId: string;
    status: "confirmed" | "failed";
    transactionHash: Hex;
    blockNumber: bigint;
    reason: string;
    now: number;
  }) {
    const statements = [
      this.database.prepare(
        `UPDATE wallet_intents
         SET status = ?2, transaction_hash = ?3, block_number = ?4,
             failure_reason = ?5, updated_at = ?6
         WHERE id = ?1 AND status IN ('submitted', 'signing')`,
      ).bind(
        input.intentId,
        input.status,
        input.transactionHash,
        input.blockNumber.toString(),
        input.status === "failed" ? input.reason : null,
        input.now,
      ),
      this.database.prepare(
        `UPDATE wallet_execution_state SET
           state = 'idle', active_intent_id = NULL, active_nonce = NULL,
           lease_expires_at = NULL, updated_at = ?2
         WHERE active_intent_id = ?1 AND state = 'submitted'`,
      ).bind(input.intentId, input.now),
    ];
    if (input.attemptId) {
      statements.push(
        this.database.prepare(
          `UPDATE testnet_transaction_attempts SET
             status = ?2, block_number = ?3, final_reason = ?4, updated_at = ?5
           WHERE id = ?1 AND status = 'submitted'`,
        ).bind(
          input.attemptId,
          input.status === "confirmed" ? "confirmed" : "reverted",
          input.blockNumber.toString(),
          input.reason,
          input.now,
        ),
      );
    }
    await this.database.batch(statements);
  }

  async markBroadcastFailed(input: {
    attemptId: string;
    execution: ProofExecution;
    transactionHash: Hex;
    reason: string;
    now: number;
  }) {
    await this.database.batch([
      this.database.prepare(
        `UPDATE testnet_transaction_attempts SET
           status = 'broadcast_failed', final_reason = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(input.attemptId, input.reason, input.now),
      this.database.prepare(
        `UPDATE wallet_intents SET
           status = 'failed', transaction_hash = ?2,
           failure_reason = ?3, updated_at = ?4
         WHERE id = ?1 AND status = 'submitted'`,
      ).bind(
        input.execution.intentId,
        input.transactionHash,
        input.reason,
        input.now,
      ),
      this.database.prepare(
        `UPDATE wallet_execution_state SET
           state = 'idle', active_intent_id = NULL, active_nonce = NULL,
           lease_expires_at = NULL, updated_at = ?2
         WHERE active_intent_id = ?1 AND state = 'submitted'`,
      ).bind(input.execution.intentId, input.now),
    ]);
  }

  async reject(input: {
    execution: ProofExecution;
    reason: string;
    now: number;
  }) {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE wallet_intents
           SET status = 'rejected', failure_reason = ?2, updated_at = ?3
           WHERE id = ?1 AND status IN ('pending', 'signing')`,
        )
        .bind(input.execution.intentId, input.reason, input.now),
      this.database
        .prepare(
          `UPDATE wallet_execution_state SET
             state = 'idle', active_intent_id = NULL, active_nonce = NULL,
             lease_expires_at = NULL, updated_at = ?2
           WHERE active_intent_id = ?1 AND state = 'reserved'`,
        )
        .bind(input.execution.intentId, input.now),
      this.database
        .prepare(
          `INSERT INTO signing_audit_log (
            id, intent_id, wallet_id, decision, reason_code, chain_id,
            target_address, selector, created_at
          ) VALUES (?1, ?2, ?3, 'rejected', ?4, 5042002, ?5, '0x', ?6)`,
        )
        .bind(
          crypto.randomUUID(),
          input.execution.intentId,
          input.execution.wallet.walletId,
          input.reason,
          input.execution.wallet.address,
          input.now,
        ),
    ]);
  }
}
