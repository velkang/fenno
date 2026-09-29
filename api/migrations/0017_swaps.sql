CREATE TABLE swap_intents (
  intent_id TEXT PRIMARY KEY REFERENCES wallet_intents(id),
  chain_id INTEGER NOT NULL,
  pool_address TEXT NOT NULL COLLATE NOCASE,
  token_address TEXT NOT NULL COLLATE NOCASE,
  token_decimals INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  token_in TEXT NOT NULL COLLATE NOCASE,
  token_out TEXT NOT NULL COLLATE NOCASE,
  recipient TEXT NOT NULL COLLATE NOCASE,
  amount_in TEXT NOT NULL,
  amount_out_minimum TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  calldata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE approval_intents ADD COLUMN pool_token_address TEXT;
