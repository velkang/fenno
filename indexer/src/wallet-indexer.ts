import {
  ARC_CHAIN_ID,
  readAlphaWalletSummary,
  type AlphaWalletSummary,
} from "@actora/chain";
import type { Address, Hex } from "viem";
import type { IndexerChainClient } from "./pool-indexer";

export type ManagedWallet = { id: string; address: Address };

export type PositionSnapshot = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  recordedOwed0: string;
  recordedOwed1: string;
  claimable0: string;
  claimable1: string;
};

export type WalletSnapshot = {
  walletId: string;
  chainId: number;
  blockNumber: number;
  blockHash: Hex;
  address: Address;
  nativeUsdc: string;
  usdc: string;
  cirBtc: string;
  positionManagerUsdcAllowance: string;
  positionManagerCirBtcAllowance: string;
  permit2UsdcAllowance: string;
  permit2CirBtcAllowance: string;
  positions: PositionSnapshot[];
  observedAt: number;
};

export type WalletReconciliation = {
  walletId: string;
  chainId: number;
  blockNumber: number;
  status: "matched" | "mismatch";
  mismatchFields: string[];
  checkedAt: number;
};

export interface WalletIndexerStore {
  listManagedWallets(limit: number): Promise<ManagedWallet[]>;
  saveSnapshot(snapshot: WalletSnapshot): Promise<void>;
  getSnapshot(input: {
    walletId: string;
    chainId: number;
    blockNumber: number;
  }): Promise<WalletSnapshot | null>;
  saveReconciliation(value: WalletReconciliation): Promise<void>;
}

const MAX_WALLETS_PER_RUN = 100;
const comparableFields = [
  "blockHash",
  "address",
  "nativeUsdc",
  "usdc",
  "cirBtc",
  "positionManagerUsdcAllowance",
  "positionManagerCirBtcAllowance",
  "permit2UsdcAllowance",
  "permit2CirBtcAllowance",
] as const satisfies readonly (keyof WalletSnapshot)[];

function normalizePositions(positions: PositionSnapshot[]): string {
  return JSON.stringify(
    [...positions].sort((left, right) =>
      BigInt(left.tokenId) === BigInt(right.tokenId)
        ? 0
        : BigInt(left.tokenId) < BigInt(right.tokenId)
          ? -1
          : 1,
    ),
  );
}

export function reconcileWalletSnapshot(
  indexed: WalletSnapshot,
  direct: WalletSnapshot,
  checkedAt: number,
): WalletReconciliation {
  const mismatchFields = comparableFields.filter(
    (field) => indexed[field] !== direct[field],
  ) as string[];
  if (normalizePositions(indexed.positions) !== normalizePositions(direct.positions)) {
    mismatchFields.push("positions");
  }
  return {
    walletId: direct.walletId,
    chainId: direct.chainId,
    blockNumber: direct.blockNumber,
    status: mismatchFields.length === 0 ? "matched" : "mismatch",
    mismatchFields,
    checkedAt,
  };
}

function snapshotFromSummary(input: {
  wallet: ManagedWallet;
  summary: AlphaWalletSummary;
  blockNumber: number;
  blockHash: Hex;
  observedAt: number;
}): WalletSnapshot {
  return {
    walletId: input.wallet.id,
    chainId: ARC_CHAIN_ID,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    address: input.summary.owner,
    nativeUsdc: input.summary.balances.nativeUsdc.raw,
    usdc: input.summary.balances.usdc.raw,
    cirBtc: input.summary.balances.cirBtc.raw,
    positionManagerUsdcAllowance:
      input.summary.allowances.positionManager.usdc.raw,
    positionManagerCirBtcAllowance:
      input.summary.allowances.positionManager.cirBtc.raw,
    permit2UsdcAllowance: input.summary.allowances.permit2.usdc.raw,
    permit2CirBtcAllowance: input.summary.allowances.permit2.cirBtc.raw,
    positions: input.summary.positions.map((position) => ({
      tokenId: position.tokenId,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity,
      recordedOwed0: position.recordedOwed0.raw,
      recordedOwed1: position.recordedOwed1.raw,
      claimable0: position.claimable0.raw,
      claimable1: position.claimable1.raw,
    })),
    observedAt: input.observedAt,
  };
}

export async function indexManagedWallets(input: {
  client: IndexerChainClient;
  store: WalletIndexerStore;
  block: { number: bigint; hash: Hex };
  now?: () => number;
}): Promise<WalletReconciliation[]> {
  const now = input.now ?? Date.now;
  const blockNumber = Number(input.block.number);
  if (!Number.isSafeInteger(blockNumber)) {
    throw new Error("Arc block number exceeds safe integer range");
  }
  const wallets = await input.store.listManagedWallets(MAX_WALLETS_PER_RUN + 1);
  if (wallets.length > MAX_WALLETS_PER_RUN) {
    throw new Error("Managed wallet indexing limit exceeded");
  }

  const results: WalletReconciliation[] = [];
  for (const wallet of wallets) {
    const direct = snapshotFromSummary({
      wallet,
      summary: await readAlphaWalletSummary(input.client, wallet.address, {
        blockNumber: input.block.number,
      }),
      blockNumber,
      blockHash: input.block.hash,
      observedAt: now(),
    });
    await input.store.saveSnapshot(direct);
    const indexed = await input.store.getSnapshot({
      walletId: wallet.id,
      chainId: ARC_CHAIN_ID,
      blockNumber,
    });
    if (!indexed) throw new Error(`Indexed wallet snapshot is missing: ${wallet.id}`);
    const reconciliation = reconcileWalletSnapshot(indexed, direct, now());
    await input.store.saveReconciliation(reconciliation);
    if (reconciliation.status === "mismatch") {
      throw new Error(
        `Wallet reconciliation mismatch for ${wallet.id}: ${reconciliation.mismatchFields.join(",")}`,
      );
    }
    results.push(reconciliation);
  }
  return results;
}
