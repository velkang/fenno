CREATE TABLE pool_directory (
  pool_address TEXT PRIMARY KEY COLLATE NOCASE,
  token_address TEXT NOT NULL COLLATE NOCASE,
  token_symbol TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  token0_address TEXT NOT NULL COLLATE NOCASE,
  token1_address TEXT NOT NULL COLLATE NOCASE,
  fee INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  usdc_reserve TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX pool_directory_token ON pool_directory(token_address);
CREATE INDEX pool_directory_symbol ON pool_directory(token_symbol COLLATE NOCASE);
