import type { Hex } from "viem";

export type MainnetSubmissionReservation = {
  intentId: string;
  walletId: string;
  nonce: number;
  leaseExpiresAt: number;
  intentStatus: string;
  intentExpiresAt: number;
};

export type MainnetSubmission = {
  attemptId: string;
  intentId: string;
  walletId: string;
  nonce: number;
  transactionHash: Hex;
  status: "submitted";
  submittedAt: number;
};

export interface MainnetSubmissionStore {
  loadReservation(intentId: string): Promise<MainnetSubmissionReservation | null>;
  commit(input: MainnetSubmission): Promise<boolean>;
}

export class MainnetSubmissionError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function handoffMainnetSubmission(input: {
  attemptId: string;
  intentId: string;
  signedNonce: number;
  transactionHash: Hex;
  store: MainnetSubmissionStore;
  now?: () => number;
}): Promise<MainnetSubmission> {
  const now = input.now ?? Date.now;
  const submittedAt = now();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId)) {
    throw new MainnetSubmissionError("SUBMISSION_ATTEMPT_ID_INVALID", 400);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.intentId)) {
    throw new MainnetSubmissionError("SUBMISSION_INTENT_ID_INVALID", 400);
  }
  if (!Number.isSafeInteger(input.signedNonce) || input.signedNonce < 0) {
    throw new MainnetSubmissionError("SIGNED_NONCE_INVALID", 400);
  }
  if (!/^0x[0-9a-f]{64}$/i.test(input.transactionHash)) {
    throw new MainnetSubmissionError("SUBMISSION_HASH_INVALID", 400);
  }

  const reservation = await input.store.loadReservation(input.intentId);
  if (!reservation) {
    throw new MainnetSubmissionError("SUBMISSION_RESERVATION_NOT_FOUND", 404);
  }
  if (reservation.intentStatus !== "pending") {
    throw new MainnetSubmissionError("SUBMISSION_INTENT_NOT_PENDING", 409);
  }
  if (reservation.intentExpiresAt <= submittedAt) {
    throw new MainnetSubmissionError("SUBMISSION_INTENT_EXPIRED", 409);
  }
  if (reservation.leaseExpiresAt <= submittedAt) {
    throw new MainnetSubmissionError("SUBMISSION_RESERVATION_EXPIRED", 409);
  }
  if (reservation.nonce !== input.signedNonce) {
    throw new MainnetSubmissionError("SUBMISSION_NONCE_MISMATCH", 409);
  }

  const submission: MainnetSubmission = {
    attemptId: input.attemptId,
    intentId: reservation.intentId,
    walletId: reservation.walletId,
    nonce: reservation.nonce,
    transactionHash: input.transactionHash,
    status: "submitted",
    submittedAt,
  };
  if (!(await input.store.commit(submission))) {
    throw new MainnetSubmissionError("SUBMISSION_HANDOFF_CONFLICT", 409);
  }
  return submission;
}
