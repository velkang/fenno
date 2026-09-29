CREATE TABLE wallet_execution_state (
  wallet_id TEXT PRIMARY KEY REFERENCES managed_wallets(id),
  state TEXT NOT NULL CHECK (state IN ('idle', 'reserved', 'submitted')),
  active_intent_id TEXT REFERENCES wallet_intents(id),
  active_nonce INTEGER,
  lease_expires_at INTEGER,
  last_observed_pending_nonce INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (state = 'idle' AND active_intent_id IS NULL AND active_nonce IS NULL AND lease_expires_at IS NULL)
    OR (state = 'reserved' AND active_intent_id IS NOT NULL AND active_nonce IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state = 'submitted' AND active_intent_id IS NOT NULL AND active_nonce IS NOT NULL)
  )
);

CREATE UNIQUE INDEX wallet_execution_active_intent
  ON wallet_execution_state(active_intent_id)
  WHERE active_intent_id IS NOT NULL;

CREATE TABLE mainnet_execution_rehearsals (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  decision TEXT NOT NULL CHECK (decision IN ('ready', 'rejected')),
  reason_code TEXT NOT NULL,
  observed_pending_nonce INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX mainnet_execution_rehearsals_intent
  ON mainnet_execution_rehearsals(intent_id, created_at DESC);
