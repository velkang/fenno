CREATE TABLE mainnet_transaction_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  transaction_hash TEXT NOT NULL UNIQUE COLLATE NOCASE,
  replaces_attempt_id TEXT REFERENCES mainnet_transaction_attempts(id),
  status TEXT NOT NULL CHECK (
    status IN ('submitted', 'confirmed', 'reverted', 'replaced', 'dropped', 'nonce_conflict')
  ),
  submitted_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  missing_observations INTEGER NOT NULL DEFAULT 0 CHECK (missing_observations >= 0),
  block_number INTEGER,
  final_reason TEXT,
  CHECK (
    (status = 'submitted' AND block_number IS NULL AND final_reason IS NULL)
    OR (status <> 'submitted' AND final_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX mainnet_transaction_attempts_active_wallet
  ON mainnet_transaction_attempts(wallet_id)
  WHERE status = 'submitted';

CREATE INDEX mainnet_transaction_attempts_intent
  ON mainnet_transaction_attempts(intent_id, submitted_at DESC);

CREATE TABLE mainnet_transaction_reconciliations (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES mainnet_transaction_attempts(id),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('pending', 'confirmed', 'reverted', 'dropped', 'nonce_conflict')
  ),
  reason_code TEXT NOT NULL,
  latest_nonce INTEGER,
  pending_nonce INTEGER,
  block_number INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX mainnet_transaction_reconciliations_attempt
  ON mainnet_transaction_reconciliations(attempt_id, created_at DESC);
