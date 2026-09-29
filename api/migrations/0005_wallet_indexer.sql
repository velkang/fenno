CREATE TABLE managed_wallet_snapshots (
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  address TEXT NOT NULL,
  native_usdc TEXT NOT NULL,
  usdc TEXT NOT NULL,
  cirbtc TEXT NOT NULL,
  position_manager_usdc_allowance TEXT NOT NULL,
  position_manager_cirbtc_allowance TEXT NOT NULL,
  permit2_usdc_allowance TEXT NOT NULL,
  permit2_cirbtc_allowance TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, chain_id, block_number)
);

CREATE TABLE uniswap_position_snapshots (
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  token_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  recorded_owed0 TEXT NOT NULL,
  recorded_owed1 TEXT NOT NULL,
  claimable0 TEXT NOT NULL,
  claimable1 TEXT NOT NULL,
  PRIMARY KEY (wallet_id, token_id, chain_id, block_number),
  FOREIGN KEY (wallet_id, chain_id, block_number)
    REFERENCES managed_wallet_snapshots(wallet_id, chain_id, block_number)
);

CREATE TABLE wallet_reconciliations (
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched', 'mismatch')),
  mismatch_fields TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, chain_id, block_number)
);

CREATE INDEX managed_wallet_snapshots_latest
  ON managed_wallet_snapshots(wallet_id, block_number DESC);
