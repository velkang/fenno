CREATE TABLE indexer_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  block_number INTEGER,
  block_hash TEXT,
  wallet_count INTEGER NOT NULL DEFAULT 0,
  reconciled_wallet_count INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX indexer_runs_latest ON indexer_runs(started_at DESC);
