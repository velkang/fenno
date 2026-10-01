export type DiscoveryCheckpoint = { name: string; blockNumber: number; updatedAt: number };

// Live pool discovery positions. The indexer's PoolDiscovery object reads the chain every
// ~10 s and saves its position when it adds pools, or about once a minute otherwise.
const DISCOVERY_CHECKPOINTS = ["v4_pools_created", "v3_pools_created"];

export interface IndexerHealthStore {
  discoveryCheckpoints(): Promise<DiscoveryCheckpoint[]>;
}

export class D1IndexerHealthStore implements IndexerHealthStore {
  constructor(private readonly db: D1Database) {}

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

/** Healthy while both protocols' discovery positions were saved recently. */
export async function getIndexerHealth(
  store: IndexerHealthStore,
  options: { now?: () => number; discoveryStaleAfterMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  // Three missed saves: the position is saved at least once a minute.
  const discoveryStaleAfterMs = options.discoveryStaleAfterMs ?? 3 * 60 * 1_000;
  const checkpoints = await store.discoveryCheckpoints();
  if (checkpoints.length === 0) {
    return { httpStatus: 503 as const, body: { status: "unavailable" as const } };
  }
  const discovery = Object.fromEntries(DISCOVERY_CHECKPOINTS.map((name) => {
    const checkpoint = checkpoints.find((entry) => entry.name === name);
    return [name.slice(0, 2), checkpoint
      ? { blockNumber: checkpoint.blockNumber, ageMs: Math.max(0, now() - checkpoint.updatedAt) }
      : null];
  })) as Record<"v4" | "v3", { blockNumber: number; ageMs: number } | null>;
  // A new pool is only as visible as the slowest discovery pass.
  const stale = Object.values(discovery).some((entry) => !entry || entry.ageMs > discoveryStaleAfterMs);
  return {
    httpStatus: stale ? 503 as const : 200 as const,
    body: { status: stale ? "stale" as const : "healthy" as const, discovery },
  };
}
