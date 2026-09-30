-- Pools are now discovered from their creation events. created_block orders
-- listings newest first; it is null for rows the backfill has not reached yet.
ALTER TABLE pool_directory ADD COLUMN created_block INTEGER;
ALTER TABLE v4_pool_directory ADD COLUMN created_block INTEGER;
CREATE INDEX pool_directory_created_block ON pool_directory (created_block);
CREATE INDEX v4_pool_directory_created_block ON v4_pool_directory (created_block);

-- Checkpoints of the replaced activity scans.
DELETE FROM chain_indexer_checkpoints
WHERE name IN ('pool_directory', 'pool_directory_state', 'v4_pool_directory', 'v4_pool_state');

-- Skips recorded under the old rules (unregistered v4 keys, non-factory v3
-- emitters, transient failures) would hide real pools from the backfill.
DELETE FROM pool_directory_skips;
