import { describe, expect, it } from "vitest";
import {
  getIndexerHealth,
  type IndexerHealthStore,
  type IndexerRun,
} from "../src/indexer-health";

function store(latest: IndexerRun | null, success: IndexerRun | null) {
  return {
    latestRun: async () => latest,
    latestSuccessfulRun: async () => success,
  } satisfies IndexerHealthStore;
}

const successfulRun = {
  status: "succeeded",
  blockNumber: 100,
  walletCount: 3,
  reconciledWalletCount: 3,
  failureCode: null,
  startedAt: 1_000,
  completedAt: 2_000,
} satisfies IndexerRun;

describe("indexer health", () => {
  it("is healthy after a recent fully reconciled run", async () => {
    const health = await getIndexerHealth(
      store(successfulRun, successfulRun),
      { now: () => 3_000, staleAfterMs: 5_000 },
    );

    expect(health.httpStatus).toBe(200);
    expect(health.body).toMatchObject({
      status: "healthy",
      latestSuccess: { blockNumber: 100, ageMs: 1_000 },
    });
  });

  it("reports stale successful indexing", async () => {
    const health = await getIndexerHealth(
      store(successfulRun, successfulRun),
      { now: () => 10_000, staleAfterMs: 5_000 },
    );

    expect(health.httpStatus).toBe(503);
    expect(health.body.status).toBe("stale");
  });

  it("surfaces the latest stable failure code", async () => {
    const failedRun = {
      ...successfulRun,
      status: "failed",
      failureCode: "WALLET_INDEX_FAILED",
      completedAt: 2_500,
    } satisfies IndexerRun;
    const health = await getIndexerHealth(store(failedRun, successfulRun), {
      now: () => 3_000,
    });

    expect(health.httpStatus).toBe(503);
    expect(health.body).toMatchObject({
      status: "failed",
      latestRun: { failureCode: "WALLET_INDEX_FAILED" },
    });
  });

  it("reports an indexer that has never run", async () => {
    const health = await getIndexerHealth(store(null, null));

    expect(health).toEqual({
      httpStatus: 503,
      body: { status: "unavailable" },
    });
  });
});
