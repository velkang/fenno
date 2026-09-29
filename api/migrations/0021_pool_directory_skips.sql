-- Pools the directory indexer has checked and rejected: not paired with USDC,
-- not a canonical Uniswap pool, or not a pool at all. Logs of busy pools recur
-- every run, so remembering the rejection keeps discovery within its budget.
-- pool_key is a v3 pool address or a v4 pool id.
CREATE TABLE pool_directory_skips (
  pool_key TEXT PRIMARY KEY COLLATE NOCASE,
  protocol TEXT NOT NULL CHECK (protocol IN ('uniswap-v3', 'uniswap-v4')),
  created_at INTEGER NOT NULL
);
