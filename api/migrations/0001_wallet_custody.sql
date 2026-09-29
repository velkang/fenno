PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  owner_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE managed_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  owner_address_at_creation TEXT NOT NULL COLLATE NOCASE,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT NOT NULL CHECK (
    state IN ('provisioning', 'active', 'paused', 'withdrawing', 'closed', 'quarantined')
  ),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  ciphertext TEXT NOT NULL,
  ciphertext_iv TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  wrapped_data_key_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE withdrawal_addresses (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  current_address TEXT NOT NULL COLLATE NOCASE,
  pending_address TEXT COLLATE NOCASE,
  pending_activates_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (pending_address IS NULL AND pending_activates_at IS NULL)
    OR (pending_address IS NOT NULL AND pending_activates_at IS NOT NULL)
  )
);

CREATE TABLE wallet_intents (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'signing', 'submitted', 'confirmed', 'rejected', 'failed', 'expired')
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX wallet_intents_wallet_status
  ON wallet_intents(wallet_id, status, created_at);

CREATE TABLE signing_audit_log (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason_code TEXT NOT NULL,
  chain_id INTEGER,
  target_address TEXT COLLATE NOCASE,
  selector TEXT,
  transaction_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX signing_audit_wallet_created
  ON signing_audit_log(wallet_id, created_at);
