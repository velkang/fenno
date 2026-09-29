PRAGMA foreign_keys = ON;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_by_user_id TEXT REFERENCES users(id),
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (used_by_user_id IS NULL AND used_at IS NULL)
    OR (used_by_user_id IS NOT NULL AND used_at IS NOT NULL)
  )
);

ALTER TABLE users ADD COLUMN invitation_id TEXT REFERENCES invitations(id);

CREATE UNIQUE INDEX users_invitation_id
  ON users(invitation_id)
  WHERE invitation_id IS NOT NULL;

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  invitation_id TEXT REFERENCES invitations(id),
  owner_address TEXT NOT NULL COLLATE NOCASE,
  nonce TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (user_id IS NOT NULL AND invitation_id IS NULL)
    OR (user_id IS NULL AND invitation_id IS NOT NULL)
  )
);

CREATE INDEX auth_challenges_owner_created
  ON auth_challenges(owner_address, created_at);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  challenge_id TEXT NOT NULL UNIQUE REFERENCES auth_challenges(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX auth_sessions_user_expires
  ON auth_sessions(user_id, expires_at);
