CREATE TABLE position_action_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  action TEXT NOT NULL CHECK (action IN ('increase', 'decrease', 'collect', 'withdraw')),
  chain_id INTEGER NOT NULL,
  position_manager TEXT NOT NULL,
  token_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  calldata TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  simulation_block INTEGER,
  simulation_block_hash TEXT,
  gas_estimate TEXT,
  simulation_output_json TEXT,
  created_at INTEGER NOT NULL
);
