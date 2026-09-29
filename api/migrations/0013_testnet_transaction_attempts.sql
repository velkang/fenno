CREATE TABLE testnet_transaction_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES wallet_intents(id),
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  transaction_hash TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL CHECK (
    status IN ('submitted', 'confirmed', 'reverted', 'broadcast_failed')
  ),
  submitted_at INTEGER NOT NULL,
  block_number INTEGER,
  final_reason TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'submitted' AND block_number IS NULL AND final_reason IS NULL)
    OR (status <> 'submitted' AND final_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX testnet_transaction_attempts_active_wallet
  ON testnet_transaction_attempts(wallet_id)
  WHERE status = 'submitted';

CREATE INDEX testnet_transaction_attempts_intent
  ON testnet_transaction_attempts(intent_id, submitted_at DESC);
