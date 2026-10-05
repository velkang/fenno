import {
  ARC_CHAIN_ID,
  PERMIT2_APPROVAL_SECONDS,
  arcV4ApprovalPayloadHash,
  buildArcV4Approval,
  v4PoolId,
} from "@stillwater/chain";
import {
  keccak256,
  zeroAddress,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  executeMainnetIntent,
  type MainnetExecutionRpc,
} from "../src/mainnet-executor";
import type {
  LoadedMainnetIntent,
  MainnetEvaluation,
  MainnetEvaluationStore,
} from "../src/mainnet-evaluator";
import type { MainnetSubmission, MainnetSubmissionStore } from "../src/mainnet-submission";

const now = 2_000_000_000_000;
const blockHash = `0x${"ab".repeat(32)}` as Hex;

class MemoryEvaluationStore implements MainnetEvaluationStore {
  evaluations: MainnetEvaluation[] = [];
  constructor(readonly intent: LoadedMainnetIntent) {}
  async load(intentId: string) {
    return intentId === this.intent.intentId ? this.intent : null;
  }
  async save(value: MainnetEvaluation) {
    this.evaluations.push(value);
  }
}

class MemoryExecutionState implements MainnetSubmissionStore {
  reservation: {
    intentId: string;
    walletId: string;
    nonce: number;
    leaseExpiresAt: number;
  } | null = null;
  submissions: MainnetSubmission[] = [];
  releases = 0;

  constructor(
    readonly intent: LoadedMainnetIntent,
    readonly allowReservation = true,
  ) {}

  async reserve(input: {
    intentId: string;
    walletId: string;
    nonce: number;
    leaseExpiresAt: number;
  }) {
    if (!this.allowReservation || this.reservation) return false;
    this.reservation = input;
    return true;
  }

  async release() {
    this.releases += 1;
    this.reservation = null;
  }

  async loadReservation(intentId: string) {
    if (!this.reservation || this.reservation.intentId !== intentId) return null;
    return {
      ...this.reservation,
      intentStatus: this.intent.status,
      intentExpiresAt: this.intent.expiresAt,
    };
  }

  async commit(input: MainnetSubmission) {
    if (!this.reservation || this.reservation.nonce !== input.nonce) return false;
    this.submissions.push(input);
    return true;
  }
}

async function fixture() {
  // Stands in for the Circle wallet: a local key that signs whatever it is given.
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = { walletId: "wallet-mainnet", circleWalletId: "circle-wallet-1", address: account.address };
  const signCalls: string[] = [];
  const signTransaction = async (circleWalletId: string, transaction: TransactionSerializableEIP1559) => {
    signCalls.push(circleWalletId);
    return account.signTransaction(transaction);
  };
  // A Permit2 approval for a native-USDC pool: a v4 intent needing only pool and token reads.
  const token = "0x2222222222222222222222222222222222222222" as const;
  const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const pool = { ...key, id: v4PoolId(key), sqrtPriceX96: (2n ** 96n).toString(),
    tick: 0, liquidity: "1000000", lpFee: 3000 };
  const stored = { pool, token, tokenDecimals: 18, stage: "permit2" as const, amount: 1_000_000n,
    expiration: BigInt(Math.floor(now / 1_000) + PERMIT2_APPROVAL_SECONDS) };
  const approval = buildArcV4Approval({ ...stored, poolId: pool.id });
  const intent: LoadedMainnetIntent = {
    intentId: "approval-mainnet",
    kind: "v4_approval",
    status: "pending",
    expiresAt: now + 60_000,
    payloadHash: arcV4ApprovalPayloadHash(approval),
    v4Approval: { ...stored, spender: approval.spender },
    wallet: { address: wallet.address, state: "active" },
    transaction: {
      chainId: ARC_CHAIN_ID,
      to: approval.to,
      data: approval.data,
      value: 0n,
    },
    custody: wallet,
  };
  return { intent, wallet, account, signCalls, signTransaction };
}

function rpc(overrides: Partial<MainnetExecutionRpc> = {}): MainnetExecutionRpc {
  return {
    getBalance: async () => 0n,
    readContract: (async ({ functionName }: { functionName: string }) =>
      functionName === "getSlot0" ? [2n ** 96n, 0, 0, 3000] : functionName === "decimals" ? 18 : 1_000_000n
    ) as MainnetExecutionRpc["readContract"],
    simulateContract: async () => { throw new Error("not used"); },
    getBlock: async () => ({ number: 100n, hash: blockHash }),
    getCode: async () => undefined,
    call: async () => ({}),
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 25_000_000_000n,
      maxPriorityFeePerGas: 0n,
    }),
    estimateGas: async () => 50_000n,
    sendRawTransaction: async ({ serializedTransaction }) =>
      keccak256(serializedTransaction),
    ...overrides,
  };
}

describe("mainnet executor", () => {
  it("evaluates, reserves, signs, persists, and broadcasts the exact transaction", async () => {
    const { intent, wallet, signCalls, signTransaction } = await fixture();
    const evaluationStore = new MemoryEvaluationStore(intent);
    const state = new MemoryExecutionState(intent);
    let signed: TransactionSerializedEIP1559 | undefined;
    const result = await executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore,
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({
        sendRawTransaction: async ({ serializedTransaction }) => {
          signed = serializedTransaction;
          expect(state.submissions).toHaveLength(1);
          return keccak256(serializedTransaction);
        },
      }),
      signTransaction,
      emergencyStop: false,
      now: () => now,
    });

    expect(result).toEqual(expect.objectContaining({
      intentId: intent.intentId,
      status: "submitted",
      nonce: 7,
      transactionHash: keccak256(signed!),
    }));
    expect(evaluationStore.evaluations[0].decision).toBe("allowed");
    expect(state.submissions[0].transactionHash).toBe(result.transactionHash);
    const parsed = parseTransaction(signed!);
    expect(parsed).toEqual(expect.objectContaining({
      chainId: ARC_CHAIN_ID,
      nonce: 7,
      gas: 60_000n,
      to: intent.transaction.to.toLowerCase(),
      data: intent.transaction.data,
    }));
    expect(parsed.value ?? 0n).toBe(0n);
    expect(await recoverTransactionAddress({ serializedTransaction: signed! }))
      .toBe(wallet.address);
    expect(signCalls).toEqual(["circle-wallet-1"]);
  });

  it("rejects under the emergency stop without signing or reserving", async () => {
    const { intent, signCalls, signTransaction } = await fixture();
    const state = new MemoryExecutionState(intent);
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc(),
      signTransaction,
      emergencyStop: true,
      now: () => now,
    })).rejects.toMatchObject({ code: "EMERGENCY_STOP_ACTIVE", status: 422 });

    expect(signCalls).toEqual([]);
    expect(state.reservation).toBeNull();
    expect(state.submissions).toEqual([]);
  });

  it("fails before signing when another execution owns the wallet slot", async () => {
    const { intent, signCalls, signTransaction } = await fixture();
    const state = new MemoryExecutionState(intent, false);
    let broadcasts = 0;
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({
        sendRawTransaction: async () => { broadcasts += 1; return `0x${"11".repeat(32)}`; },
      }),
      signTransaction,
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "WALLET_EXECUTION_BUSY", status: 409 });

    expect(broadcasts).toBe(0);
    expect(signCalls).toEqual([]);
    expect(state.submissions).toEqual([]);
  });

  it("releases the reservation when Circle fails to sign", async () => {
    const { intent } = await fixture();
    const state = new MemoryExecutionState(intent);
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc(),
      signTransaction: async () => { throw new Error("CIRCLE_500"); },
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "MAINNET_SIGNING_FAILED", status: 500 });

    expect(state.releases).toBe(1);
    expect(state.reservation).toBeNull();
  });

  it("refuses a signature from a different wallet and never broadcasts it", async () => {
    const { intent } = await fixture();
    const state = new MemoryExecutionState(intent);
    const stranger = privateKeyToAccount(generatePrivateKey());
    let broadcasts = 0;
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({ sendRawTransaction: async () => { broadcasts += 1; return `0x${"11".repeat(32)}`; } }),
      signTransaction: async (_id, transaction) => stranger.signTransaction(transaction),
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "MAINNET_SIGNING_FAILED" });

    expect(broadcasts).toBe(0);
    expect(state.submissions).toEqual([]);
    expect(state.releases).toBe(1);
  });

  it("refuses a signed transaction that differs from the one built", async () => {
    const { intent, account } = await fixture();
    const state = new MemoryExecutionState(intent);
    let broadcasts = 0;
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({ sendRawTransaction: async () => { broadcasts += 1; return `0x${"11".repeat(32)}`; } }),
      signTransaction: async (_id, transaction) =>
        account.signTransaction({ ...transaction, to: account.address }),
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "MAINNET_SIGNING_FAILED" });

    expect(broadcasts).toBe(0);
    expect(state.submissions).toEqual([]);
    expect(state.releases).toBe(1);
  });

  it("keeps an atomically persisted hash submitted after an ambiguous broadcast", async () => {
    const { intent, signTransaction } = await fixture();
    const state = new MemoryExecutionState(intent);
    const result = await executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({ sendRawTransaction: async () => { throw new Error("timeout"); } }),
      signTransaction,
      emergencyStop: false,
      now: () => now,
    });

    expect(result.status).toBe("submitted");
    expect(state.submissions[0].transactionHash).toBe(result.transactionHash);
  });

  it("fails closed when the RPC returns a different transaction hash", async () => {
    const { intent, signTransaction } = await fixture();
    const state = new MemoryExecutionState(intent);
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({
        sendRawTransaction: async () => `0x${"ff".repeat(32)}`,
      }),
      signTransaction,
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "BROADCAST_HASH_MISMATCH", status: 502 });

    expect(state.submissions).toHaveLength(1);
  });
});
