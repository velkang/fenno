-- The indexer no longer copies wallet and cirBTC-pool state into the database every five
-- minutes: no screen read those copies (balances and positions are read from the chain), and
-- their writes grew with time and with every wallet. Drop the six tables that job wrote.
-- Children first: uniswap_position_snapshots references managed_wallet_snapshots.
DROP TABLE IF EXISTS wallet_reconciliations;
DROP TABLE IF EXISTS pool_reconciliations;
DROP TABLE IF EXISTS uniswap_position_snapshots;
DROP TABLE IF EXISTS managed_wallet_snapshots;
DROP TABLE IF EXISTS uniswap_pool_snapshots;
DROP TABLE IF EXISTS indexer_runs;

-- Listed pools now expire after a week unless a user has acted on them. That check looks
-- each pool up in the intent tables, so index their pool columns: without these it would
-- read every intent row on every run.
CREATE INDEX mint_intents_pool ON mint_intents (pool_address COLLATE NOCASE);
CREATE INDEX approval_intents_pool ON approval_intents (pool_address COLLATE NOCASE);
CREATE INDEX swap_intents_pool ON swap_intents (pool_address COLLATE NOCASE);
CREATE INDEX v4_mint_intents_pool ON v4_mint_intents (pool_id);
CREATE INDEX v4_approval_intents_pool ON v4_approval_intents (pool_id);
CREATE INDEX v4_swap_intents_pool ON v4_swap_intents (pool_id);
CREATE INDEX v4_position_action_intents_pool ON v4_position_action_intents (pool_id);
