CREATE TABLE usdc_withdrawal_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL,
  recipient TEXT NOT NULL COLLATE NOCASE,
  amount TEXT NOT NULL,
  owner_address TEXT NOT NULL COLLATE NOCASE,
  owner_signature TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  signature_expires_at INTEGER NOT NULL,
  calldata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
