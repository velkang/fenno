-- Stillwater wallet keys now live in Circle developer-controlled wallets; the
-- signer no longer holds encrypted private keys. Rebuild managed_wallets
-- without the key columns (SQLite cannot drop NOT NULL columns in place) and
-- add the Circle wallet id.
--
-- Existing wallets have no Circle wallet and can no longer sign, so they are
-- closed. Their encrypted key material is kept, unread, in legacy_wallet_keys
-- in case anything was left behind: it can be decrypted offline with
-- WALLET_KEK_V1 and the "actora-wallet-v1:" AAD. History rows stay attached.
PRAGMA defer_foreign_keys = on;

CREATE TABLE legacy_wallet_keys (
  wallet_id TEXT PRIMARY KEY,
  address TEXT NOT NULL COLLATE NOCASE,
  key_version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  ciphertext_iv TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  wrapped_data_key_iv TEXT NOT NULL
);

INSERT INTO legacy_wallet_keys
SELECT id, address, key_version, ciphertext, ciphertext_iv, wrapped_data_key, wrapped_data_key_iv
FROM managed_wallets;

-- Parent rows must be re-inserted after the drop: SQLite only clears the
-- deferred foreign-key violations the drop creates when matching parents are
-- inserted afterwards.
CREATE TABLE managed_wallets_copy AS
SELECT id, user_id, owner_address_at_creation, address, created_at FROM managed_wallets;

DROP TABLE managed_wallets;

CREATE TABLE managed_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  owner_address_at_creation TEXT NOT NULL COLLATE NOCASE,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT NOT NULL CHECK (
    state IN ('provisioning', 'active', 'paused', 'withdrawing', 'closed', 'quarantined')
  ),
  circle_wallet_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO managed_wallets (
  id, user_id, owner_address_at_creation, address, state, circle_wallet_id, created_at, updated_at
)
SELECT id, user_id, owner_address_at_creation, address, 'closed', NULL, created_at,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM managed_wallets_copy;

DROP TABLE managed_wallets_copy;
