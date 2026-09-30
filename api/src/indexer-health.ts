export type IndexerRun = {
  status: "running" | "succeeded" | "failed";
  blockNumber: number | null;
  walletCount: number;
  reconciledWalletCount: number;
  failureCode: string | null;
  startedAt: number;
  completedAt: number | null;
};

export type DiscoveryCheckpoint = { name: string; blockNumber: number; updatedAt: number };

// Live pool discovery checkpoints, advanced every ~10 s by the indexer's PoolDiscovery object.
const DISCOVERY_CHECKPOINTS = ["v4_pools_created", "v3_pools_created"];

export interface IndexerHealthStore {
  latestRun(): Promise<IndexerRun | null>;
  latestSuccessfulRun(): Promise<IndexerRun | null>;
  discoveryCheckpoints(): Promise<DiscoveryCheckpoint[]>;
}

export class D1IndexerHealthStore implements IndexerHealthStore {
  constructor(private readonly db: D1Database) {}

  private async read(where = ""): Promise<IndexerRun | null> {
    const row = await this.db
      .prepare(
        `SELECT status, block_number, wallet_count, reconciled_wallet_count,
                failure_code, started_at, completed_at
         FROM indexer_runs ${where} ORDER BY started_at DESC LIMIT 1`,
      )
      .first<Record<string, string | number | null>>();
    if (!row) return null;
    return {
      status: String(row.status) as IndexerRun["status"],
      blockNumber: row.block_number === null ? null : Number(row.block_number),
      walletCount: Number(row.wallet_count),
      reconciledWalletCount: Number(row.reconciled_wallet_count),
      failureCode: row.failure_code === null ? null : String(row.failure_code),
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  latestRun() {
    return this.read();
  }

  latestSuccessfulRun() {
    return this.read("WHERE status = 'succeeded'");
  }

  async discoveryCheckpoints() {
    const rows = await this.db.prepare(
      `SELECT name, block_number, updated_at FROM chain_indexer_checkpoints
       WHERE name IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(DISCOVERY_CHECKPOINTS))
      .all<{ name: string; block_number: number; updated_at: number }>();
    return rows.results.map((row) => ({ name: row.name, blockNumber: Number(row.block_number),
      updatedAt: Number(row.updated_at) }));
  }
}

export async function getIndexerHealth(
  store: IndexerHealthStore,
  options: { now?: () => number; staleAfterMs?: number; discoveryStaleAfterMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1_000;
  const discoveryStaleAfterMs = options.discoveryStaleAfterMs ?? 60 * 1_000;
  const [latestRun, latestSuccess, checkpoints] = await Promise.all([
    store.latestRun(),
    store.latestSuccessfulRun(),
    store.discoveryCheckpoints(),
  ]);
  if (!latestRun) {
    return { httpStatus: 503 as const, body: { status: "unavailable" as const } };
  }

  const successAgeMs = latestSuccess?.completedAt === null || !latestSuccess
    ? null
    : Math.max(0, now() - latestSuccess.completedAt);
  const discovery = Object.fromEntries(DISCOVERY_CHECKPOINTS.map((name) => {
    const checkpoint = checkpoints.find((entry) => entry.name === name);
    return [name.slice(0, 2), checkpoint
      ? { blockNumber: checkpoint.blockNumber, ageMs: Math.max(0, now() - checkpoint.updatedAt) }
      : null];
  })) as Record<"v4" | "v3", { blockNumber: number; ageMs: number } | null>;
  // A new pool is only as visible as the slowest discovery pass.
  const discoveryStale = Object.values(discovery).some((entry) => !entry || entry.ageMs > discoveryStaleAfterMs);
  const stale = successAgeMs === null || successAgeMs > staleAfterMs || discoveryStale;
  const status = latestRun.status === "failed"
    ? "failed"
    : stale
      ? "stale"
      : latestRun.status === "running"
        ? "running"
        : "healthy";

  return {
    httpStatus: status === "healthy" || status === "running" ? 200 as const : 503 as const,
    body: {
      status,
      latestRun: {
        status: latestRun.status,
        blockNumber: latestRun.blockNumber,
        failureCode: latestRun.failureCode,
        startedAt: latestRun.startedAt,
        completedAt: latestRun.completedAt,
      },
      latestSuccess: latestSuccess
        ? {
            blockNumber: latestSuccess.blockNumber,
            walletCount: latestSuccess.walletCount,
            reconciledWalletCount: latestSuccess.reconciledWalletCount,
            completedAt: latestSuccess.completedAt,
            ageMs: successAgeMs,
          }
        : null,
      discovery,
    },
  };
}
