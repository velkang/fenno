import { describe, expect, it } from "vitest";
import {
  ALPHA_POOL,
  ARC_TOKENS,
  UNISWAP_V3_ARC,
} from "@stillwater/chain";
import type { Address } from "viem";
import type { IndexerChainClient } from "../src/pool-indexer";
import {
  indexManagedWallets,
  reconcileWalletSnapshot,
  type ManagedWallet,
  type WalletIndexerStore,
  type WalletReconciliation,
  type WalletSnapshot,
} from "../src/wallet-indexer";

const address = "0x1111111111111111111111111111111111111111" as Address;
const blockHash = `0x${"cd".repeat(32)}` as const;

class MemoryWalletStore implements WalletIndexerStore {
  wallets: ManagedWallet[] = [{ id: "wallet-1", address }];
  snapshots = new Map<string, WalletSnapshot>();
  reconciliations: WalletReconciliation[] = [];

  async listManagedWallets(limit: number) {
    return this.wallets.slice(0, limit);
  }

  async saveSnapshot(snapshot: WalletSnapshot) {
    const key = `${snapshot.walletId}:${snapshot.chainId}:${snapshot.blockNumber}`;
    if (!this.snapshots.has(key)) this.snapshots.set(key, snapshot);
  }

  async getSnapshot(input: {
    walletId: string;
    chainId: number;
    blockNumber: number;
  }) {
    return this.snapshots.get(
      `${input.walletId}:${input.chainId}:${input.blockNumber}`,
    ) ?? null;
  }

  async saveReconciliation(value: WalletReconciliation) {
    this.reconciliations.push(value);
  }
}

function fakeClient(seenBlocks: Array<bigint | undefined>): IndexerChainClient {
  return {
    async getBlock() {
      return { number: 700n, hash: blockHash };
    },
    async getBalance(parameters) {
      seenBlocks.push(parameters.blockNumber);
      return 1_000_000_000_000_000_000n;
    },
    async simulateContract() {
      return { result: [0n, 0n] };
    },
    async readContract(parameters) {
      seenBlocks.push(parameters.blockNumber);
      if (parameters.address === ALPHA_POOL.address) {
        if (parameters.functionName === "slot0") {
          return [1n << 96n, 0, 0, 0, 0, 0, true];
        }
        if (parameters.functionName === "liquidity") return 100n;
        if (parameters.functionName === "token0") return ALPHA_POOL.token0.address;
        if (parameters.functionName === "token1") return ALPHA_POOL.token1.address;
        if (parameters.functionName === "fee") return ALPHA_POOL.fee;
        if (parameters.functionName === "tickSpacing") return ALPHA_POOL.tickSpacing;
      }
      if (
        parameters.address === UNISWAP_V3_ARC.nonfungiblePositionManager.address &&
        parameters.functionName === "balanceOf"
      ) {
        return 0n;
      }
      if (parameters.functionName === "balanceOf") {
        return parameters.address === ARC_TOKENS.USDC.address ? 2_000_000n : 3n;
      }
      if (parameters.functionName === "allowance") return 4n;
      throw new Error(`Unexpected ${parameters.functionName}`);
    },
  };
}

describe("managed wallet indexer", () => {
  it("pins balances, allowances, and position enumeration to the pool block", async () => {
    const seenBlocks: Array<bigint | undefined> = [];
    const store = new MemoryWalletStore();

    const result = await indexManagedWallets({
      client: fakeClient(seenBlocks),
      store,
      block: { number: 700n, hash: blockHash },
      now: () => 1_000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("matched");
    expect([...store.snapshots.values()][0]).toMatchObject({
      blockNumber: 700,
      nativeUsdc: "1000000000000000000",
      usdc: "2000000",
      positions: [],
    });
    expect(seenBlocks.length).toBeGreaterThan(6);
    expect(seenBlocks.every((block) => block === 700n)).toBe(true);
  });

  it("treats any position difference as a reconciliation failure", () => {
    const snapshot = [...new MemoryWalletStore().snapshots.values()][0] ?? {
      walletId: "wallet-1",
      chainId: 5_042,
      blockNumber: 700,
      blockHash,
      address,
      nativeUsdc: "1",
      usdc: "2",
      cirBtc: "3",
      positionManagerUsdcAllowance: "4",
      positionManagerCirBtcAllowance: "5",
      permit2UsdcAllowance: "6",
      permit2CirBtcAllowance: "7",
      positions: [],
      observedAt: 1_000,
    } satisfies WalletSnapshot;
    const direct = {
      ...snapshot,
      positions: [{
        tokenId: "9",
        tickLower: -1,
        tickUpper: 1,
        liquidity: "10",
        recordedOwed0: "0",
        recordedOwed1: "0",
        claimable0: "1",
        claimable1: "2",
      }],
    };

    expect(reconcileWalletSnapshot(snapshot, direct, 2_000)).toMatchObject({
      status: "mismatch",
      mismatchFields: ["positions"],
    });
  });
});
