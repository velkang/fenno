import { describe, expect, it } from "vitest";
import type { IndexerChainClient } from "../src/pool-indexer";
import { runIndexer, type IndexerRunStore } from "../src/run";

class MemoryRunStore implements IndexerRunStore {
  started: unknown[] = [];
  succeeded: unknown[] = [];
  failed: unknown[] = [];

  async start(input: unknown) {
    this.started.push(input);
  }
  async succeed(input: unknown) {
    this.succeeded.push(input);
  }
  async fail(input: unknown) {
    this.failed.push(input);
  }
}

describe("indexer run lifecycle", () => {
  it("records a stable failure code and preserves the original error", async () => {
    const runStore = new MemoryRunStore();
    const client = {
      getBlock: async () => ({ number: null, hash: null }),
    } as unknown as IndexerChainClient;

    await expect(
      runIndexer({
        client,
        poolStore: {} as never,
        walletStore: {} as never,
        runStore,
        runId: "run-1",
        now: () => 1_000,
      }),
    ).rejects.toThrow("Arc safe block is unavailable");

    expect(runStore.started).toEqual([{ id: "run-1", startedAt: 1_000 }]);
    expect(runStore.succeeded).toEqual([]);
    expect(runStore.failed).toEqual([
      {
        id: "run-1",
        blockNumber: null,
        blockHash: null,
        failureCode: "ARC_SAFE_BLOCK_UNAVAILABLE",
        completedAt: 1_000,
      },
    ]);
  });
});
