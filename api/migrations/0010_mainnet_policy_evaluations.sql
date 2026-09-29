CREATE TABLE mainnet_policy_evaluations (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'rejected')),
  reason_code TEXT NOT NULL,
  block_number INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX mainnet_policy_evaluations_intent
  ON mainnet_policy_evaluations(intent_id, created_at DESC);
