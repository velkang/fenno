import {
  ARC_TESTNET_PROOF_KIND,
  arcTestnetProofPayloadHash,
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
  executeTestnetProof,
  ProofExecutionError,
  type ProofExecution,
  type ProofRpc,
  type ProofStore,
} from "../src/proof";

const now = 1_800_000_000_000;
class MemoryProofStore implements ProofStore {
  rejectedReason: string | null = null;
  reservedNonce: number | null = null;
  broadcastFailure: string | null = null;

  constructor(
    readonly execution: ProofExecution,
    readonly reservationAllowed = true,
  ) {}

  async getExecution(intentId: string, walletId: string) {
    return this.execution.intentId === intentId &&
      this.execution.wallet.walletId === walletId
      ? this.execution
      : null;
  }

  async reserveNonce(input: { nonce: number }) {
    if (!this.reservationAllowed || this.reservedNonce !== null) return false;
    this.reservedNonce = input.nonce;
    return true;
  }

  async handoffSubmitted(input: {
    attemptId: string;
    nonce: number;
    transactionHash: Hex;
  }) {
    if (this.reservedNonce !== input.nonce) return false;
    this.execution.intentStatus = "submitted";
    this.execution.transactionHash = input.transactionHash;
    this.execution.attemptId = input.attemptId;
    return true;
  }

  async markFinal(input: { status: "confirmed" | "failed" }) {
    this.execution.intentStatus = input.status;
    this.reservedNonce = null;
  }

  async markBroadcastFailed(input: { reason: string }) {
    this.broadcastFailure = input.reason;
    this.execution.intentStatus = "failed";
    this.reservedNonce = null;
  }

  async reject(input: { reason: string }) {
    this.rejectedReason = input.reason;
    this.execution.intentStatus = "rejected";
    this.reservedNonce = null;
  }
}

async function fixture() {
  const wrappingKey = await importWrappingKey(generateWrappingKey());
  const wallet = await provisionEncryptedWallet(
    wrappingKey,
    1,
    "wallet-proof-execution",
  );
  const execution: ProofExecution = {
    intentId: "proof-intent",
    intentKind: ARC_TESTNET_PROOF_KIND,
    intentStatus: "pending",
    intentExpiresAt: now + 60_000,
    payloadHash: arcTestnetProofPayloadHash({
      walletId: wallet.walletId,
      address: wallet.address,
    }),
    transactionHash: null,
    attemptId: null,
    wallet,
    walletState: "active",
    verifiedOwnerAddress: wallet.address,
  };
  return { execution, wrappingKey };
}

describe("persisted Arc Testnet proof", () => {
  it("signs, broadcasts, and confirms the constrained self-transfer", async () => {
    const { execution, wrappingKey } = await fixture();
    const store = new MemoryProofStore(execution);
    let signed: TransactionSerializedEIP1559 | undefined;
    const rpc: ProofRpc = {
      getTransactionCount: async () => 7,
      estimateFees: async () => ({
        maxFeePerGas: 25_000_000_000n,
        maxPriorityFeePerGas: 0n,
      }),
      sendRawTransaction: async (transaction) => {
        signed = transaction;
        return keccak256(transaction);
      },
      waitForReceipt: async () => ({ status: "success", blockNumber: 42n }),
    };

    const result = await executeTestnetProof(
      store,
      rpc,
      new Map([[1, wrappingKey]]),
      { intentId: execution.intentId, walletId: execution.wallet.walletId, now },
    );

    expect(result).toEqual({
      intentId: execution.intentId,
      status: "confirmed",
      transactionHash: keccak256(signed!),
      blockNumber: "42",
    });
    expect(execution.intentStatus).toBe("confirmed");
    expect(await recoverTransactionAddress({ serializedTransaction: signed! })).toBe(
      execution.wallet.address,
    );
    const parsed = parseTransaction(signed!);
    expect(parsed).toEqual(
      expect.objectContaining({
        chainId: 5_042_002,
        nonce: 7,
        gas: 21_000n,
      }),
    );
    expect(parsed.to?.toLowerCase()).toBe(execution.wallet.address.toLowerCase());
    expect(parsed.data ?? "0x").toBe("0x");
    expect(parsed.value ?? 0n).toBe(0n);
  });

  it("fails closed before broadcast when the wallet is paused", async () => {
    const { execution, wrappingKey } = await fixture();
    execution.walletState = "paused";
    const store = new MemoryProofStore(execution);
    let broadcast = false;
    const rpc: ProofRpc = {
      getTransactionCount: async () => 0,
      estimateFees: async () => ({
        maxFeePerGas: 25_000_000_000n,
        maxPriorityFeePerGas: 0n,
      }),
      sendRawTransaction: async () => {
        broadcast = true;
        return `0x${"12".repeat(32)}`;
      },
      waitForReceipt: async () => ({ status: "success", blockNumber: 1n }),
    };

    await expect(
      executeTestnetProof(store, rpc, new Map([[1, wrappingKey]]), {
        intentId: execution.intentId,
        walletId: execution.wallet.walletId,
        now,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProofExecutionError>>({
        code: "WALLET_NOT_SIGNABLE",
      }),
    );
    expect(broadcast).toBe(false);
    expect(store.rejectedReason).toBe("WALLET_NOT_SIGNABLE");
    expect(execution.intentStatus).toBe("rejected");
  });

  it("does not decrypt, sign, or broadcast when another execution owns the wallet slot", async () => {
    const { execution, wrappingKey } = await fixture();
    const store = new MemoryProofStore(execution, false);
    let broadcast = false;
    await expect(executeTestnetProof(
      store,
      {
        getTransactionCount: async () => 7,
        estimateFees: async () => ({
          maxFeePerGas: 25_000_000_000n,
          maxPriorityFeePerGas: 0n,
        }),
        sendRawTransaction: async () => {
          broadcast = true;
          return `0x${"12".repeat(32)}`;
        },
        waitForReceipt: async () => ({ status: "success", blockNumber: 1n }),
      },
      new Map([[1, wrappingKey]]),
      { intentId: execution.intentId, walletId: execution.wallet.walletId, now },
    )).rejects.toMatchObject({ code: "WALLET_EXECUTION_BUSY" });

    expect(broadcast).toBe(false);
    expect(execution.intentStatus).toBe("pending");
  });

  it("keeps the derived hash submitted when broadcast outcome is ambiguous", async () => {
    const { execution, wrappingKey } = await fixture();
    const store = new MemoryProofStore(execution);
    const result = await executeTestnetProof(
      store,
      {
        getTransactionCount: async () => 7,
        estimateFees: async () => ({
          maxFeePerGas: 25_000_000_000n,
          maxPriorityFeePerGas: 0n,
        }),
        sendRawTransaction: async () => { throw new Error("network timeout"); },
        waitForReceipt: async () => { throw new Error("not called"); },
      },
      new Map([[1, wrappingKey]]),
      { intentId: execution.intentId, walletId: execution.wallet.walletId, now },
    );

    expect(result.status).toBe("submitted");
    expect(result.transactionHash).toBe(execution.transactionHash);
    expect(execution.intentStatus).toBe("submitted");
    expect(execution.attemptId).toMatch(/^testnet_attempt_/);
  });

  it("finalizes a deterministic insufficient-funds broadcast failure", async () => {
    const { execution, wrappingKey } = await fixture();
    const store = new MemoryProofStore(execution);
    await expect(executeTestnetProof(
      store,
      {
        getTransactionCount: async () => 7,
        estimateFees: async () => ({
          maxFeePerGas: 25_000_000_000n,
          maxPriorityFeePerGas: 0n,
        }),
        sendRawTransaction: async () => { throw new Error("insufficient funds"); },
        waitForReceipt: async () => { throw new Error("not called"); },
      },
      new Map([[1, wrappingKey]]),
      { intentId: execution.intentId, walletId: execution.wallet.walletId, now },
    )).rejects.toMatchObject({ code: "TESTNET_WALLET_NEEDS_GAS" });

    expect(store.broadcastFailure).toBe("TESTNET_WALLET_NEEDS_GAS");
    expect(execution.intentStatus).toBe("failed");
    expect(store.reservedNonce).toBeNull();
  });
});
