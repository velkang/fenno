-- Arc Testnet support was removed; the app is mainnet-only. Free any wallet
-- execution slot a testnet proof still holds, close out unfinished proof
-- intents, and drop the testnet-only table and index. Finished proof intents
-- and their audit log rows stay as history.
UPDATE wallet_execution_state
SET state = 'idle', active_intent_id = NULL, active_nonce = NULL, lease_expires_at = NULL,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE active_intent_id IN (
  SELECT id FROM wallet_intents WHERE kind = 'arc_testnet_self_transfer'
);

UPDATE wallet_intents
SET status = 'failed', failure_reason = 'TESTNET_REMOVED',
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE kind = 'arc_testnet_self_transfer' AND status IN ('pending', 'signing', 'submitted');

DROP INDEX IF EXISTS wallet_intents_one_testnet_proof;
DROP TABLE testnet_transaction_attempts;
