-- Sign-up no longer needs an invitation. Rebuild auth_challenges without
-- invitation_id and the CHECK that required one for first-time wallets.
-- The invitations table and users.invitation_id stay: existing users rows
-- reference them, and rebuilding users would touch every custody table.
--
-- auth_sessions references auth_challenges, so existing sessions are cleared
-- first; everyone signs in again once.
DELETE FROM auth_sessions;

CREATE TABLE auth_challenges_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  owner_address TEXT NOT NULL COLLATE NOCASE,
  nonce TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO auth_challenges_v2 (
  id, user_id, owner_address, nonce, message, expires_at, used_at, created_at
)
SELECT id, user_id, owner_address, nonce, message, expires_at, used_at, created_at
FROM auth_challenges;

DROP TABLE auth_challenges;
ALTER TABLE auth_challenges_v2 RENAME TO auth_challenges;

CREATE INDEX auth_challenges_owner_created
  ON auth_challenges(owner_address, created_at);
