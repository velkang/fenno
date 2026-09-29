import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  handoffMainnetSubmission,
  type MainnetSubmission,
  type MainnetSubmissionReservation,
  type MainnetSubmissionStore,
} from "../src/mainnet-submission";

const now = 2_000_000_000_000;
const transactionHash = `0x${"44".repeat(32)}` as Hex;

class MemoryStore implements MainnetSubmissionStore {
  committed: MainnetSubmission | null = null;

  constructor(
    readonly reservation: MainnetSubmissionReservation | null,
    readonly acceptsCommit = true,
  ) {}

  async loadReservation(intentId: string) {
    return this.reservation?.intentId === intentId ? this.reservation : null;
  }

  async commit(input: MainnetSubmission) {
    if (!this.acceptsCommit) return false;
    this.committed = input;
    return true;
  }
}

function reservation(
  overrides: Partial<MainnetSubmissionReservation> = {},
): MainnetSubmissionReservation {
  return {
    intentId: "intent-1",
    walletId: "wallet-1",
    nonce: 7,
    leaseExpiresAt: now + 30_000,
    intentStatus: "pending",
    intentExpiresAt: now + 60_000,
    ...overrides,
  };
}

describe("mainnet submission handoff", () => {
  it("atomically hands the exact reserved nonce to one submitted attempt", async () => {
    const store = new MemoryStore(reservation());
    const result = await handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash,
      store,
      now: () => now,
    });

    expect(result).toEqual({
      attemptId: "attempt-1",
      intentId: "intent-1",
      walletId: "wallet-1",
      nonce: 7,
      transactionHash,
      status: "submitted",
      submittedAt: now,
    });
    expect(store.committed).toEqual(result);
  });

  it("rejects an expired reservation before committing", async () => {
    const store = new MemoryStore(reservation({ leaseExpiresAt: now }));
    await expect(handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash,
      store,
      now: () => now,
    })).rejects.toMatchObject({ code: "SUBMISSION_RESERVATION_EXPIRED", status: 409 });
    expect(store.committed).toBeNull();
  });

  it("rejects an expired intent even when its reservation lease is live", async () => {
    const store = new MemoryStore(reservation({ intentExpiresAt: now }));
    await expect(handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash,
      store,
      now: () => now,
    })).rejects.toMatchObject({ code: "SUBMISSION_INTENT_EXPIRED", status: 409 });
    expect(store.committed).toBeNull();
  });

  it("rejects nonce drift before committing", async () => {
    const store = new MemoryStore(reservation());
    await expect(handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 8,
      transactionHash,
      store,
      now: () => now,
    })).rejects.toMatchObject({ code: "SUBMISSION_NONCE_MISMATCH", status: 409 });
    expect(store.committed).toBeNull();
  });

  it("fails closed when the atomic store preconditions changed", async () => {
    const store = new MemoryStore(reservation(), false);
    await expect(handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash,
      store,
      now: () => now,
    })).rejects.toMatchObject({ code: "SUBMISSION_HANDOFF_CONFLICT", status: 409 });
  });

  it("rejects missing reservations and malformed identities before submission", async () => {
    await expect(handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash,
      store: new MemoryStore(null),
    })).rejects.toMatchObject({ code: "SUBMISSION_RESERVATION_NOT_FOUND", status: 404 });

    await expect(handoffMainnetSubmission({
      attemptId: "bad attempt",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash,
      store: new MemoryStore(reservation()),
    })).rejects.toMatchObject({ code: "SUBMISSION_ATTEMPT_ID_INVALID", status: 400 });

    await expect(handoffMainnetSubmission({
      attemptId: "attempt-1",
      intentId: "intent-1",
      signedNonce: 7,
      transactionHash: "0x1234" as Hex,
      store: new MemoryStore(reservation()),
    })).rejects.toMatchObject({ code: "SUBMISSION_HASH_INVALID", status: 400 });
  });
});
