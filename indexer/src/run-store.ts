import type { IndexerRunStore } from "./run";

export class D1IndexerRunStore implements IndexerRunStore {
  constructor(private readonly db: D1Database) {}

  async start(input: { id: string; startedAt: number }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO indexer_runs (id, status, started_at)
         VALUES (?1, 'running', ?2)`,
      )
      .bind(input.id, input.startedAt)
      .run();
  }

  async succeed(input: {
    id: string;
    blockNumber: number;
    blockHash: `0x${string}`;
    walletCount: number;
    completedAt: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE indexer_runs SET
          status = 'succeeded', block_number = ?2, block_hash = ?3,
          wallet_count = ?4, reconciled_wallet_count = ?4,
          failure_code = NULL, completed_at = ?5
         WHERE id = ?1 AND status = 'running'`,
      )
      .bind(
        input.id,
        input.blockNumber,
        input.blockHash,
        input.walletCount,
        input.completedAt,
      )
      .run();
  }

  async fail(input: {
    id: string;
    blockNumber: number | null;
    blockHash: `0x${string}` | null;
    failureCode: string;
    completedAt: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE indexer_runs SET
          status = 'failed', block_number = ?2, block_hash = ?3,
          failure_code = ?4, completed_at = ?5
         WHERE id = ?1 AND status = 'running'`,
      )
      .bind(
        input.id,
        input.blockNumber,
        input.blockHash,
        input.failureCode,
        input.completedAt,
      )
      .run();
  }
}
