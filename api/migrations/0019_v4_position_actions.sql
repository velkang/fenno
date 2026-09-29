CREATE TABLE v4_position_action_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  action TEXT NOT NULL CHECK (action IN ('collect', 'withdraw')),
  pool_id TEXT NOT NULL COLLATE NOCASE,
  token_id TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  slippage_bps INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  calldata TEXT NOT NULL,
  simulation_block INTEGER NOT NULL,
  simulation_block_hash TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
