import type {
  PoolIndexerStore,
  PoolSnapshot,
  Reconciliation,
} from "./pool-indexer";

export class D1PoolIndexerStore implements PoolIndexerStore {
  constructor(private readonly db: D1Database) {}

  async saveSnapshotAndCheckpoint(snapshot: PoolSnapshot): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO uniswap_pool_snapshots (
            chain_id, pool_address, block_number, block_hash, sqrt_price_x96,
            tick, liquidity, token1_per_token0, token0_per_token1, observed_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          snapshot.chainId,
          snapshot.poolAddress,
          snapshot.blockNumber,
          snapshot.blockHash,
          snapshot.sqrtPriceX96,
          snapshot.tick,
          snapshot.liquidity,
          snapshot.token1PerToken0,
          snapshot.token0PerToken1,
          snapshot.observedAt,
        ),
      this.db
        .prepare(
          `INSERT INTO chain_indexer_checkpoints (
            name, chain_id, block_number, block_hash, updated_at
          ) VALUES ('alpha_pool', ?1, ?2, ?3, ?4)
          ON CONFLICT(name) DO UPDATE SET
            chain_id = excluded.chain_id,
            block_number = excluded.block_number,
            block_hash = excluded.block_hash,
            updated_at = excluded.updated_at
          WHERE excluded.block_number >= chain_indexer_checkpoints.block_number`,
        )
        .bind(
          snapshot.chainId,
          snapshot.blockNumber,
          snapshot.blockHash,
          snapshot.observedAt,
        ),
    ]);
  }

  async getSnapshot(input: {
    chainId: number;
    poolAddress: string;
    blockNumber: number;
  }): Promise<PoolSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT chain_id, pool_address, block_number, block_hash, sqrt_price_x96,
                tick, liquidity, token1_per_token0, token0_per_token1, observed_at
         FROM uniswap_pool_snapshots
         WHERE chain_id = ?1 AND pool_address = ?2 AND block_number = ?3`,
      )
      .bind(input.chainId, input.poolAddress, input.blockNumber)
      .first<Record<string, string | number>>();
    if (!row) return null;
    return {
      chainId: Number(row.chain_id),
      poolAddress: String(row.pool_address),
      blockNumber: Number(row.block_number),
      blockHash: String(row.block_hash) as `0x${string}`,
      sqrtPriceX96: String(row.sqrt_price_x96),
      tick: Number(row.tick),
      liquidity: String(row.liquidity),
      token1PerToken0: String(row.token1_per_token0),
      token0PerToken1: String(row.token0_per_token1),
      observedAt: Number(row.observed_at),
    };
  }

  async saveReconciliation(value: Reconciliation): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pool_reconciliations (
          chain_id, pool_address, block_number, status, mismatch_fields, checked_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(chain_id, pool_address, block_number) DO UPDATE SET
          status = excluded.status,
          mismatch_fields = excluded.mismatch_fields,
          checked_at = excluded.checked_at`,
      )
      .bind(
        value.chainId,
        value.poolAddress,
        value.blockNumber,
        value.status,
        value.mismatchFields.length > 0
          ? JSON.stringify(value.mismatchFields)
          : null,
        value.checkedAt,
      )
      .run();
  }
}
