import {
  ARC_CHAIN_ID,
  alphaApprovalPayloadHash,
  buildAlphaApproval,
} from "@stillwater/chain";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  generateWrappingKey,
  importWrappingKey,
  provisionEncryptedWallet,
} from "../src/crypto";
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
  const wrappingKey = await importWrappingKey(generateWrappingKey());
  const wallet = await provisionEncryptedWallet(wrappingKey, 1, "wallet-mainnet");
  const approval = buildAlphaApproval({ token: "USDC", amount: 1_000_000n });
  const intent: LoadedMainnetIntent = {
    intentId: "approval-mainnet",
    kind: "erc20_approval",
    status: "pending",
    expiresAt: now + 60_000,
    payloadHash: alphaApprovalPayloadHash(approval),
    wallet: { address: wallet.address, state: "active" },
    transaction: {
      chainId: ARC_CHAIN_ID,
      to: approval.to,
      data: approval.data,
      value: 0n,
    },
    encryptedWallet: wallet,
  };
  return { intent, wallet, wrappingKey };
}

function rpc(overrides: Partial<MainnetExecutionRpc> = {}): MainnetExecutionRpc {
  return {
    getBalance: async () => 0n,
    readContract: async () => { throw new Error("not used"); },
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
    const { intent, wallet, wrappingKey } = await fixture();
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
      getWrappingKeys: async () => new Map([[1, wrappingKey]]),
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
      to: intent.transaction.to,
      data: intent.transaction.data,
    }));
    expect(parsed.value ?? 0n).toBe(0n);
    expect(await recoverTransactionAddress({ serializedTransaction: signed! }))
      .toBe(wallet.address);
  });

  it("rejects under the emergency stop without loading wrapping keys or reserving", async () => {
    const { intent } = await fixture();
    const state = new MemoryExecutionState(intent);
    let keyLoads = 0;
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc(),
      getWrappingKeys: async () => { keyLoads += 1; return new Map(); },
      emergencyStop: true,
      now: () => now,
    })).rejects.toMatchObject({ code: "EMERGENCY_STOP_ACTIVE", status: 422 });

    expect(keyLoads).toBe(0);
    expect(state.reservation).toBeNull();
    expect(state.submissions).toEqual([]);
  });

  it("fails before decryption when another execution owns the wallet slot", async () => {
    const { intent, wrappingKey } = await fixture();
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
      getWrappingKeys: async () => new Map([[1, wrappingKey]]),
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "WALLET_EXECUTION_BUSY", status: 409 });

    expect(broadcasts).toBe(0);
    expect(state.submissions).toEqual([]);
  });

  it("releases the reservation when wallet decryption fails", async () => {
    const { intent } = await fixture();
    const state = new MemoryExecutionState(intent);
    const wrongKey = await importWrappingKey(generateWrappingKey());
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc(),
      getWrappingKeys: async () => new Map([[1, wrongKey]]),
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "MAINNET_SIGNING_FAILED", status: 500 });

    expect(state.releases).toBe(1);
    expect(state.reservation).toBeNull();
  });

  it("keeps an atomically persisted hash submitted after an ambiguous broadcast", async () => {
    const { intent, wrappingKey } = await fixture();
    const state = new MemoryExecutionState(intent);
    const result = await executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({ sendRawTransaction: async () => { throw new Error("timeout"); } }),
      getWrappingKeys: async () => new Map([[1, wrappingKey]]),
      emergencyStop: false,
      now: () => now,
    });

    expect(result.status).toBe("submitted");
    expect(state.submissions[0].transactionHash).toBe(result.transactionHash);
  });

  it("fails closed when the RPC returns a different transaction hash", async () => {
    const { intent, wrappingKey } = await fixture();
    const state = new MemoryExecutionState(intent);
    await expect(executeMainnetIntent({
      intentId: intent.intentId,
      evaluationStore: new MemoryEvaluationStore(intent),
      reservationStore: state,
      submissionStore: state,
      rpc: rpc({
        sendRawTransaction: async () => `0x${"ff".repeat(32)}`,
      }),
      getWrappingKeys: async () => new Map([[1, wrappingKey]]),
      emergencyStop: false,
      now: () => now,
    })).rejects.toMatchObject({ code: "BROADCAST_HASH_MISMATCH", status: 502 });

    expect(state.submissions).toHaveLength(1);
  });
});
