CREATE TABLE chain_indexer_checkpoints (
  name TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE uniswap_pool_snapshots (
  chain_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  token1_per_token0 TEXT NOT NULL,
  token0_per_token1 TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, pool_address, block_number)
);

CREATE TABLE pool_reconciliations (
  chain_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'mismatch')),
  mismatch_fields TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, pool_address, block_number)
);
