import { describe, expect, it } from "vitest";
import type { MainnetEvaluation } from "../src/mainnet-evaluator";
import {
  rehearseMainnetExecution,
  type ExecutionRehearsal,
  type ExecutionRehearsalStore,
} from "../src/mainnet-rehearsal";

const address = "0x1111111111111111111111111111111111111111" as const;
const now = 2_000_000_000_000;

class MemoryStore implements ExecutionRehearsalStore {
  rehearsals: ExecutionRehearsal[] = [];
  reservations: Array<{ intentId: string; walletId: string; nonce: number; now: number; leaseExpiresAt: number }> = [];
  releases: Array<{ intentId: string; walletId: string; nonce: number; now: number }> = [];

  constructor(
    readonly hasWallet = true,
    readonly reservationAllowed = true,
  ) {}

  async getWallet() {
    return this.hasWallet ? { walletId: "wallet-1", address } : null;
  }

  async reserve(input: { intentId: string; walletId: string; nonce: number; now: number; leaseExpiresAt: number }) {
    this.reservations.push(input);
    return this.reservationAllowed;
  }

  async release(input: { intentId: string; walletId: string; nonce: number; now: number }) {
    this.releases.push(input);
  }

  async save(value: ExecutionRehearsal) {
    this.rehearsals.push(value);
  }
}

function evaluation(decision: "allowed" | "rejected", reasonCode: string): MainnetEvaluation {
  return {
    intentId: "intent-1",
    decision,
    reasonCode,
    blockNumber: 100,
    createdAt: now,
  };
}

describe("mainnet execution rehearsal", () => {
  it("reserves the observed pending nonce, records readiness, and releases the lease", async () => {
    const store = new MemoryStore();
    const result = await rehearseMainnetExecution({
      intentId: "intent-1",
      store,
      evaluate: async () => evaluation("allowed", "POLICY_ALLOWED"),
      rpc: { getTransactionCount: async () => 7 },
      now: () => now,
    });

    expect(result).toEqual({
      intentId: "intent-1",
      walletId: "wallet-1",
      decision: "ready",
      reasonCode: "REHEARSAL_READY",
      observedPendingNonce: 7,
      createdAt: now,
    });
    expect(store.reservations).toEqual([{
      intentId: "intent-1",
      walletId: "wallet-1",
      nonce: 7,
      now,
      leaseExpiresAt: now + 30_000,
    }]);
    expect(store.releases).toEqual([{
      intentId: "intent-1",
      walletId: "wallet-1",
      nonce: 7,
      now,
    }]);
    expect(store.rehearsals).toEqual([result]);
  });

  it("does not read or reserve a nonce when policy rejects", async () => {
    const store = new MemoryStore();
    let nonceReads = 0;
    const result = await rehearseMainnetExecution({
      intentId: "intent-1",
      store,
      evaluate: async () => evaluation("rejected", "EMERGENCY_STOP_ACTIVE"),
      rpc: { getTransactionCount: async () => { nonceReads += 1; return 7; } },
      now: () => now,
    });

    expect(result.reasonCode).toBe("EMERGENCY_STOP_ACTIVE");
    expect(result.observedPendingNonce).toBeNull();
    expect(nonceReads).toBe(0);
    expect(store.reservations).toEqual([]);
    expect(store.releases).toEqual([]);
  });

  it("records a busy rejection without releasing another execution lease", async () => {
    const store = new MemoryStore(true, false);
    const result = await rehearseMainnetExecution({
      intentId: "intent-1",
      store,
      evaluate: async () => evaluation("allowed", "POLICY_ALLOWED"),
      rpc: { getTransactionCount: async () => 8 },
      now: () => now,
    });

    expect(result.reasonCode).toBe("WALLET_EXECUTION_BUSY");
    expect(result.observedPendingNonce).toBe(8);
    expect(store.releases).toEqual([]);
  });

  it("fails with a stable error for a missing intent wallet or invalid nonce", async () => {
    await expect(rehearseMainnetExecution({
      intentId: "missing",
      store: new MemoryStore(false),
      evaluate: async () => evaluation("allowed", "POLICY_ALLOWED"),
      rpc: { getTransactionCount: async () => 0 },
    })).rejects.toMatchObject({
      code: "REHEARSAL_INTENT_NOT_FOUND",
      status: 404,
    });

    await expect(rehearseMainnetExecution({
      intentId: "intent-1",
      store: new MemoryStore(),
      evaluate: async () => evaluation("allowed", "POLICY_ALLOWED"),
      rpc: { getTransactionCount: async () => -1 },
    })).rejects.toMatchObject({
      code: "PENDING_NONCE_INVALID",
      status: 503,
    });
  });
});
