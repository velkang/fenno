ALTER TABLE wallet_intents ADD COLUMN transaction_hash TEXT;
ALTER TABLE wallet_intents ADD COLUMN block_number INTEGER;
ALTER TABLE wallet_intents ADD COLUMN failure_reason TEXT;

CREATE UNIQUE INDEX wallet_intents_one_testnet_proof
  ON wallet_intents(wallet_id, kind)
  WHERE kind = 'arc_testnet_self_transfer';
