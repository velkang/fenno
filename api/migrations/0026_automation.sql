-- Automation: a user's mandate lets the agent work one v4 pool for their wallet, within
-- limits. Each thing the agent does (or proposes) is a run. The signer checks every agent
-- request against its run and mandate before anything is signed.
CREATE TABLE automation_mandates (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES managed_wallets(id),
  pool_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'autopilot')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  band TEXT NOT NULL CHECK (band IN ('wide', 'balanced', 'narrow', 'agent')),
  max_position_usd INTEGER NOT NULL CHECK (max_position_usd > 0),
  max_runs_per_day INTEGER NOT NULL CHECK (max_runs_per_day BETWEEN 1 AND 24),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One live mandate per wallet and pool.
CREATE UNIQUE INDEX automation_mandates_live
  ON automation_mandates (wallet_id, pool_id) WHERE status != 'revoked';
-- A wallet's mandates, revoked ones included (their runs stay in the history).
CREATE INDEX automation_mandates_wallet ON automation_mandates (wallet_id);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES automation_mandates(id),
  kind TEXT NOT NULL CHECK (kind IN ('rebalance', 'close')),
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'running', 'done', 'failed', 'declined', 'expired')
  ),
  band TEXT CHECK (band IN ('wide', 'balanced', 'narrow')),
  -- Why: the user started it, or what the agent saw and decided, in plain words.
  trigger TEXT NOT NULL,
  reason TEXT,
  provider TEXT,
  model TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
-- Runs per mandate, and how many started in the last day.
CREATE INDEX automation_runs_mandate ON automation_runs (mandate_id, started_at);
-- At most one proposal or run in progress per mandate.
CREATE UNIQUE INDEX automation_runs_open
  ON automation_runs (mandate_id) WHERE status IN ('proposed', 'running');

-- Empty for everything the user does; the agent's requests carry their run.
ALTER TABLE wallet_intents ADD COLUMN automation_run_id TEXT REFERENCES automation_runs(id);
CREATE INDEX wallet_intents_automation_run
  ON wallet_intents (automation_run_id) WHERE automation_run_id IS NOT NULL;
