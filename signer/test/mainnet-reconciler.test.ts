import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  MainnetReconciliationError,
  reconcileMainnetAttempt,
  recordMainnetReplacement,
  type MainnetAttempt,
  type MainnetReceiptRpc,
  type MainnetReplacementStore,
  type ReconciliationOutcome,
} from "../src/mainnet-reconciler";

const now = 2_000_000_000_000;
const hash = `0x${"11".repeat(32)}` as Hex;
const replacementHash = `0x${"22".repeat(32)}` as Hex;

function fixture(overrides: Partial<MainnetAttempt> = {}): MainnetAttempt {
  return {
    attemptId: "attempt-1",
    intentId: "intent-1",
    walletId: "wallet-1",
    walletAddress: "0x1111111111111111111111111111111111111111",
    nonce: 7,
    transactionHash: hash,
    status: "submitted",
    submittedAt: now - 60_000,
    missingObservations: 0,
    blockNumber: null,
    finalReason: null,
    ...overrides,
  };
}

class MemoryStore implements MainnetReplacementStore {
  observations: Array<{ outcome: ReconciliationOutcome; reasonCode: string }> = [];
  finalized: { reasonCode: string; quarantineWallet: boolean } | null = null;
  replacement: MainnetAttempt | null = null;

  constructor(readonly attempt: MainnetAttempt | null) {}

  async load(attemptId: string) {
    if (this.replacement?.attemptId === attemptId) return this.replacement;
    return this.attempt?.attemptId === attemptId ? this.attempt : null;
  }

  async observe(input: { outcome: ReconciliationOutcome; reasonCode: string }) {
    this.observations.push(input);
    if (this.attempt && input.reasonCode === "TRANSACTION_NOT_FOUND") {
      this.attempt.missingObservations += 1;
    }
  }

  async finalize(input: {
    attemptStatus: "confirmed" | "reverted" | "dropped" | "nonce_conflict";
    intentStatus: "confirmed" | "failed";
    reasonCode: string;
    blockNumber: number | null;
    quarantineWallet: boolean;
  }) {
    if (this.attempt) {
      this.attempt.status = input.attemptStatus;
      this.attempt.blockNumber = input.blockNumber;
      this.attempt.finalReason = input.reasonCode;
    }
    this.finalized = input;
  }

  async replace(input: {
    replacementAttemptId: string;
    replacementHash: Hex;
    now: number;
  }) {
    if (!this.attempt || this.attempt.status !== "submitted") return false;
    this.attempt.status = "replaced";
    this.attempt.finalReason = "REPLACED_BY_FEE_BUMP";
    this.replacement = fixture({
      attemptId: input.replacementAttemptId,
      transactionHash: input.replacementHash,
      submittedAt: input.now,
    });
    return true;
  }
}

function rpc(overrides: Partial<MainnetReceiptRpc> = {}): MainnetReceiptRpc {
  return {
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ nonce: 7 }),
    getTransactionCount: async (_address, blockTag) => blockTag === "latest" ? 7 : 8,
    ...overrides,
  };
}

describe("mainnet transaction reconciliation", () => {
  it("confirms a successful receipt and is idempotent after finalization", async () => {
    const store = new MemoryStore(fixture());
    let receiptReads = 0;
    const first = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: rpc({
        getTransactionReceipt: async () => {
          receiptReads += 1;
          return { status: "success", blockNumber: 123n };
        },
      }),
      now: () => now,
    });
    const second = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: rpc({ getTransactionReceipt: async () => { receiptReads += 1; return null; } }),
      now: () => now + 1,
    });

    expect(first).toEqual(expect.objectContaining({
      status: "confirmed",
      reasonCode: "RECEIPT_CONFIRMED",
      blockNumber: 123,
    }));
    expect(second.status).toBe("confirmed");
    expect(receiptReads).toBe(1);
  });

  it("marks a reverted receipt as failed", async () => {
    const store = new MemoryStore(fixture());
    const result = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: rpc({
        getTransactionReceipt: async () => ({ status: "reverted", blockNumber: 124n }),
      }),
      now: () => now,
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("RECEIPT_REVERTED");
    expect(store.attempt?.status).toBe("reverted");
  });

  it("keeps a visible transaction submitted without reading wallet nonces", async () => {
    const store = new MemoryStore(fixture({ missingObservations: 2 }));
    let nonceReads = 0;
    const result = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: rpc({
        getTransactionCount: async () => { nonceReads += 1; return 0; },
      }),
      now: () => now,
    });

    expect(result.reasonCode).toBe("TRANSACTION_PENDING");
    expect(nonceReads).toBe(0);
    expect(store.observations).toEqual([expect.objectContaining({
      outcome: "pending",
      reasonCode: "TRANSACTION_PENDING",
    })]);
  });

  it("requires both age and repeated absence before marking a transaction dropped", async () => {
    const attempt = fixture({
      submittedAt: now - 20 * 60_000,
      missingObservations: 1,
    });
    const store = new MemoryStore(attempt);
    const missingRpc = rpc({ getTransaction: async () => null });
    const first = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: missingRpc,
      now: () => now,
      missingObservationThreshold: 3,
    });
    const second = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: missingRpc,
      now: () => now + 1,
      missingObservationThreshold: 3,
    });

    expect(first.reasonCode).toBe("TRANSACTION_NOT_FOUND");
    expect(second.reasonCode).toBe("TRANSACTION_DROPPED");
    expect(attempt.status).toBe("dropped");
  });

  it("quarantines the wallet when an unknown transaction consumed the nonce", async () => {
    const store = new MemoryStore(fixture());
    const result = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: rpc({
        getTransaction: async () => null,
        getTransactionCount: async (_address, blockTag) => blockTag === "latest" ? 8 : 8,
      }),
      now: () => now,
    });

    expect(result.status).toBe("quarantined");
    expect(result.reasonCode).toBe("NONCE_CONSUMED_BY_UNKNOWN_TRANSACTION");
    expect(store.finalized?.quarantineWallet).toBe(true);
  });

  it("quarantines a stored hash whose chain transaction has a different nonce", async () => {
    const store = new MemoryStore(fixture());
    const result = await reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store,
      rpc: rpc({ getTransaction: async () => ({ nonce: 9 }) }),
      now: () => now,
    });

    expect(result.status).toBe("quarantined");
    expect(result.reasonCode).toBe("TRANSACTION_NONCE_MISMATCH");
  });

  it("records an explicit replacement at the same serialized wallet slot", async () => {
    const store = new MemoryStore(fixture());
    const result = await recordMainnetReplacement({
      attemptId: "attempt-1",
      replacementAttemptId: "attempt-2",
      replacementHash,
      store,
      now: () => now,
    });

    expect(store.attempt?.status).toBe("replaced");
    expect(store.replacement).toEqual(expect.objectContaining({
      attemptId: "attempt-2",
      nonce: 7,
      transactionHash: replacementHash,
      status: "submitted",
    }));
    expect(result.reasonCode).toBe("REPLACEMENT_SUBMITTED");
  });

  it("rejects missing attempts, malformed replacements, and invalid chain nonces", async () => {
    await expect(reconcileMainnetAttempt({
      attemptId: "missing",
      store: new MemoryStore(null),
      rpc: rpc(),
    })).rejects.toMatchObject({ code: "MAINNET_ATTEMPT_NOT_FOUND", status: 404 });

    await expect(recordMainnetReplacement({
      attemptId: "attempt-1",
      replacementAttemptId: "attempt-2",
      replacementHash: "0x1234" as Hex,
      store: new MemoryStore(fixture()),
    })).rejects.toMatchObject({ code: "REPLACEMENT_HASH_INVALID", status: 400 });

    await expect(reconcileMainnetAttempt({
      attemptId: "attempt-1",
      store: new MemoryStore(fixture()),
      rpc: rpc({
        getTransaction: async () => null,
        getTransactionCount: async (_address, blockTag) => blockTag === "latest" ? 8 : 7,
      }),
    })).rejects.toBeInstanceOf(MainnetReconciliationError);
  });
});
