import type { Hex } from "viem";
import { indexAlphaPool, type IndexerChainClient } from "./pool-indexer";
import { indexManagedWallets } from "./wallet-indexer";
import type { PoolIndexerStore } from "./pool-indexer";
import type { WalletIndexerStore } from "./wallet-indexer";

export type IndexerFailureCode =
  | "ARC_SAFE_BLOCK_UNAVAILABLE"
  | "POOL_INDEX_FAILED"
  | "WALLET_INDEX_FAILED";

export interface IndexerRunStore {
  start(input: { id: string; startedAt: number }): Promise<void>;
  succeed(input: {
    id: string;
    blockNumber: number;
    blockHash: Hex;
    walletCount: number;
    completedAt: number;
  }): Promise<void>;
  fail(input: {
    id: string;
    blockNumber: number | null;
    blockHash: Hex | null;
    failureCode: IndexerFailureCode;
    completedAt: number;
  }): Promise<void>;
}

export async function runIndexer(input: {
  client: IndexerChainClient;
  poolStore: PoolIndexerStore;
  walletStore: WalletIndexerStore;
  runStore: IndexerRunStore;
  runId?: string;
  now?: () => number;
}): Promise<{ blockNumber: number; walletCount: number }> {
  const now = input.now ?? Date.now;
  const runId = input.runId ?? crypto.randomUUID();
  await input.runStore.start({ id: runId, startedAt: now() });

  let block: { number: bigint; hash: Hex } | null = null;
  let stage: "block" | "pool" | "wallet" = "block";
  try {
    const safeBlock = await input.client.getBlock({ blockTag: "safe" });
    if (safeBlock.number === null || safeBlock.hash === null) {
      throw new Error("Arc safe block is unavailable");
    }
    block = { number: safeBlock.number, hash: safeBlock.hash };
    const blockNumber = Number(block.number);
    if (!Number.isSafeInteger(blockNumber)) {
      throw new Error("Arc block number exceeds safe integer range");
    }

    stage = "pool";
    await indexAlphaPool({
      client: input.client,
      store: input.poolStore,
      block,
      now,
    });
    stage = "wallet";
    const wallets = await indexManagedWallets({
      client: input.client,
      store: input.walletStore,
      block,
      now,
    });
    await input.runStore.succeed({
      id: runId,
      blockNumber,
      blockHash: block.hash,
      walletCount: wallets.length,
      completedAt: now(),
    });
    return { blockNumber, walletCount: wallets.length };
  } catch (error) {
    const failureCode: IndexerFailureCode =
      stage === "block"
        ? "ARC_SAFE_BLOCK_UNAVAILABLE"
        : stage === "pool"
          ? "POOL_INDEX_FAILED"
          : "WALLET_INDEX_FAILED";
    await input.runStore.fail({
      id: runId,
      blockNumber: block ? Number(block.number) : null,
      blockHash: block?.hash ?? null,
      failureCode,
      completedAt: now(),
    });
    throw error;
  }
}
