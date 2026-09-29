import {
  ALPHA_POOL,
  ARC_CHAIN_ID,
  readAlphaPoolState,
  type AlphaPoolState,
  type ChainReadClient,
} from "@actora/chain";
import type { Hex } from "viem";

export type IndexerChainClient = ChainReadClient & {
  getBlock(parameters: { blockTag: "safe" }): Promise<{
    number: bigint | null;
    hash: Hex | null;
  }>;
};

export type ArcSafeBlock = { number: bigint; hash: Hex };

export type PoolSnapshot = {
  chainId: number;
  poolAddress: string;
  blockNumber: number;
  blockHash: Hex;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  token1PerToken0: string;
  token0PerToken1: string;
  observedAt: number;
};

export type Reconciliation = {
  chainId: number;
  poolAddress: string;
  blockNumber: number;
  status: "matched" | "mismatch";
  mismatchFields: string[];
  checkedAt: number;
};

export interface PoolIndexerStore {
  saveSnapshotAndCheckpoint(snapshot: PoolSnapshot): Promise<void>;
  getSnapshot(input: {
    chainId: number;
    poolAddress: string;
    blockNumber: number;
  }): Promise<PoolSnapshot | null>;
  saveReconciliation(reconciliation: Reconciliation): Promise<void>;
}

const comparableFields = [
  "blockHash",
  "sqrtPriceX96",
  "tick",
  "liquidity",
  "token1PerToken0",
  "token0PerToken1",
] as const satisfies readonly (keyof PoolSnapshot)[];

export function reconcilePoolSnapshot(
  indexed: PoolSnapshot,
  direct: PoolSnapshot,
  checkedAt: number,
): Reconciliation {
  const mismatchFields = comparableFields.filter(
    (field) => indexed[field] !== direct[field],
  );
  return {
    chainId: direct.chainId,
    poolAddress: direct.poolAddress,
    blockNumber: direct.blockNumber,
    status: mismatchFields.length === 0 ? "matched" : "mismatch",
    mismatchFields,
    checkedAt,
  };
}

function snapshotFromState(
  state: AlphaPoolState,
  blockNumber: bigint,
  blockHash: Hex,
  observedAt: number,
): PoolSnapshot {
  const safeBlockNumber = Number(blockNumber);
  if (!Number.isSafeInteger(safeBlockNumber)) {
    throw new Error("Arc block number exceeds safe integer range");
  }
  return {
    chainId: ARC_CHAIN_ID,
    poolAddress: state.address,
    blockNumber: safeBlockNumber,
    blockHash,
    sqrtPriceX96: state.sqrtPriceX96,
    tick: state.tick,
    liquidity: state.liquidity,
    token1PerToken0: state.token1PerToken0,
    token0PerToken1: state.token0PerToken1,
    observedAt,
  };
}

export async function indexAlphaPool(input: {
  client: IndexerChainClient;
  store: PoolIndexerStore;
  block?: ArcSafeBlock;
  now?: () => number;
}): Promise<Reconciliation> {
  const now = input.now ?? Date.now;
  const requestedBlock = input.block ??
    (await input.client.getBlock({ blockTag: "safe" }));
  if (requestedBlock.number === null || requestedBlock.hash === null) {
    throw new Error("Arc safe block is unavailable");
  }
  const block: ArcSafeBlock = {
    number: requestedBlock.number,
    hash: requestedBlock.hash,
  };
  const direct = snapshotFromState(
    await readAlphaPoolState(input.client, { blockNumber: block.number }),
    block.number,
    block.hash,
    now(),
  );
  await input.store.saveSnapshotAndCheckpoint(direct);
  const indexed = await input.store.getSnapshot({
    chainId: ARC_CHAIN_ID,
    poolAddress: ALPHA_POOL.address,
    blockNumber: direct.blockNumber,
  });
  if (!indexed) throw new Error("Indexed Arc pool snapshot is missing");

  const reconciliation = reconcilePoolSnapshot(indexed, direct, now());
  await input.store.saveReconciliation(reconciliation);
  if (reconciliation.status === "mismatch") {
    throw new Error(
      `Arc pool reconciliation mismatch: ${reconciliation.mismatchFields.join(",")}`,
    );
  }
  return reconciliation;
}
