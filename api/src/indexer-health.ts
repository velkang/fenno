export type IndexerRun = {
  status: "running" | "succeeded" | "failed";
  blockNumber: number | null;
  walletCount: number;
  reconciledWalletCount: number;
  failureCode: string | null;
  startedAt: number;
  completedAt: number | null;
};

export interface IndexerHealthStore {
  latestRun(): Promise<IndexerRun | null>;
  latestSuccessfulRun(): Promise<IndexerRun | null>;
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
}

export async function getIndexerHealth(
  store: IndexerHealthStore,
  options: { now?: () => number; staleAfterMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1_000;
  const [latestRun, latestSuccess] = await Promise.all([
    store.latestRun(),
    store.latestSuccessfulRun(),
  ]);
  if (!latestRun) {
    return { httpStatus: 503 as const, body: { status: "unavailable" as const } };
  }

  const successAgeMs = latestSuccess?.completedAt === null || !latestSuccess
    ? null
    : Math.max(0, now() - latestSuccess.completedAt);
  const stale = successAgeMs === null || successAgeMs > staleAfterMs;
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
    },
  };
}
