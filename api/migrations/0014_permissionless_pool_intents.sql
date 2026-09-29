CREATE TABLE approval_intents_v2 (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL,
  token_symbol TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_decimals INTEGER,
  pool_address TEXT,
  spender TEXT NOT NULL,
  amount TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO approval_intents_v2 (
  intent_id, chain_id, token_symbol, token_address, spender, amount,
  calldata, simulation_block, simulation_block_hash, gas_estimate, created_at
)
SELECT intent_id, chain_id, token_symbol, token_address, spender, amount,
       calldata, simulation_block, simulation_block_hash, gas_estimate, created_at
FROM approval_intents;

DROP TABLE approval_intents;
ALTER TABLE approval_intents_v2 RENAME TO approval_intents;

ALTER TABLE mint_intents ADD COLUMN token_address TEXT;
ALTER TABLE mint_intents ADD COLUMN token_symbol TEXT;
ALTER TABLE mint_intents ADD COLUMN token_decimals INTEGER;
ALTER TABLE mint_intents ADD COLUMN pool_address TEXT;
ALTER TABLE mint_intents ADD COLUMN token0_address TEXT;
ALTER TABLE mint_intents ADD COLUMN token1_address TEXT;
ALTER TABLE mint_intents ADD COLUMN fee INTEGER;
ALTER TABLE mint_intents ADD COLUMN tick_spacing INTEGER;
