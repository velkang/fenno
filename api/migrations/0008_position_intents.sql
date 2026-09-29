CREATE TABLE mint_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL,
  position_manager TEXT NOT NULL,
  recipient TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  amount_cirbtc_desired TEXT NOT NULL,
  amount_usdc_desired TEXT NOT NULL,
  amount_cirbtc_min TEXT NOT NULL,
  amount_usdc_min TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  calldata TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  simulated_token_id TEXT,
  simulated_liquidity TEXT,
  simulated_amount_cirbtc TEXT,
  simulated_amount_usdc TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE position_imports (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  token_id TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  verified_block INTEGER NOT NULL,
  verified_block_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (wallet_id, token_id)
);
