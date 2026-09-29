ALTER TABLE wallet_intents ADD COLUMN idempotency_key_hash TEXT;

CREATE UNIQUE INDEX wallet_intents_idempotency
  ON wallet_intents(wallet_id, kind, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

CREATE TABLE approval_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL,
  token_symbol TEXT NOT NULL CHECK (token_symbol IN ('USDC', 'cirBTC')),
  token_address TEXT NOT NULL,
  spender TEXT NOT NULL,
  amount TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  created_at INTEGER NOT NULL
);
