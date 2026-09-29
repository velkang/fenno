CREATE TABLE v4_pool_directory (
  pool_id TEXT PRIMARY KEY COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  token_address TEXT NOT NULL COLLATE NOCASE,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  lp_fee INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX v4_pool_directory_token ON v4_pool_directory(token_address);
CREATE INDEX v4_pool_directory_symbol ON v4_pool_directory(token_symbol COLLATE NOCASE);

CREATE TABLE v4_mint_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  token_decimals INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  lp_fee INTEGER NOT NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  amount0_desired TEXT NOT NULL,
  amount1_desired TEXT NOT NULL,
  amount0_max TEXT NOT NULL,
  amount1_max TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  calldata TEXT NOT NULL,
  native_value TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE v4_approval_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  token TEXT NOT NULL COLLATE NOCASE,
  token_decimals INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('erc20', 'permit2')),
  spender TEXT NOT NULL COLLATE NOCASE,
  amount TEXT NOT NULL,
  expiration TEXT NOT NULL,
  target TEXT NOT NULL COLLATE NOCASE,
  calldata TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE v4_swap_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  currency0 TEXT NOT NULL COLLATE NOCASE,
  currency1 TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks TEXT NOT NULL COLLATE NOCASE,
  token_in TEXT NOT NULL COLLATE NOCASE,
  amount_in TEXT NOT NULL,
  amount_out_minimum TEXT NOT NULL,
  deadline TEXT NOT NULL,
  calldata TEXT NOT NULL,
  native_value TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
