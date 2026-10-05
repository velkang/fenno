import type { Address, Hex } from "viem";
import { v4MintedTokenIds } from "@stillwater/chain";

export type MainnetAttemptStatus =
  | "submitted"
  | "confirmed"
  | "reverted"
  | "replaced"
  | "dropped"
  | "nonce_conflict";

export type MainnetAttempt = {
  attemptId: string;
  intentId: string;
  walletId: string;
  walletAddress: Address;
  nonce: number;
  transactionHash: Hex;
  status: MainnetAttemptStatus;
  submittedAt: number;
  missingObservations: number;
  blockNumber: number | null;
  finalReason: string | null;
};

export type ReconciliationOutcome =
  | "pending"
  | "confirmed"
  | "reverted"
  | "dropped"
  | "nonce_conflict";

export type MainnetReconciliation = {
  attemptId: string;
  intentId: string;
  status: "submitted" | "confirmed" | "failed" | "quarantined" | "replaced";
  reasonCode: string;
  transactionHash: Hex;
  blockNumber: number | null;
  latestNonce: number | null;
  pendingNonce: number | null;
  createdAt: number;
};

export interface MainnetReconciliationStore {
  load(attemptId: string): Promise<MainnetAttempt | null>;
  observe(input: {
    attempt: MainnetAttempt;
    outcome: ReconciliationOutcome;
    reasonCode: string;
    latestNonce: number | null;
    pendingNonce: number | null;
    blockNumber: number | null;
    now: number;
  }): Promise<void>;
  finalize(input: {
    attempt: MainnetAttempt;
    attemptStatus: Exclude<MainnetAttemptStatus, "submitted" | "replaced">;
    intentStatus: "confirmed" | "failed";
    reasonCode: string;
    blockNumber: number | null;
    latestNonce: number | null;
    pendingNonce: number | null;
    quarantineWallet: boolean;
    // The position NFT a confirmed v4 mint gave the wallet.
    v4TokenId?: string | null;
    now: number;
  }): Promise<void>;
}

export interface MainnetReplacementStore extends MainnetReconciliationStore {
  replace(input: {
    attempt: MainnetAttempt;
    replacementAttemptId: string;
    replacementHash: Hex;
    now: number;
  }): Promise<boolean>;
}

export interface MainnetReceiptRpc {
  getTransactionReceipt(hash: Hex): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
  } | null>;
  getTransaction(hash: Hex): Promise<{ nonce: number } | null>;
  getTransactionCount(address: Address, blockTag: "latest" | "pending"): Promise<number>;
}

export class MainnetReconciliationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function recordMainnetReplacement(input: {
  attemptId: string;
  replacementAttemptId: string;
  replacementHash: Hex;
  store: MainnetReplacementStore;
  now?: () => number;
}): Promise<MainnetReconciliation> {
  const now = input.now ?? Date.now;
  const replacedAt = now();
  const attempt = await input.store.load(input.attemptId);
  if (!attempt) {
    throw new MainnetReconciliationError("MAINNET_ATTEMPT_NOT_FOUND", 404);
  }
  if (attempt.status !== "submitted") {
    throw new MainnetReconciliationError("MAINNET_ATTEMPT_NOT_SUBMITTED", 409);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.replacementAttemptId)) {
    throw new MainnetReconciliationError("REPLACEMENT_ATTEMPT_ID_INVALID", 400);
  }
  if (!/^0x[0-9a-f]{64}$/i.test(input.replacementHash)) {
    throw new MainnetReconciliationError("REPLACEMENT_HASH_INVALID", 400);
  }
  if (input.replacementHash.toLowerCase() === attempt.transactionHash.toLowerCase()) {
    throw new MainnetReconciliationError("REPLACEMENT_HASH_UNCHANGED", 409);
  }
  if (!(await input.store.replace({
    attempt,
    replacementAttemptId: input.replacementAttemptId,
    replacementHash: input.replacementHash,
    now: replacedAt,
  }))) {
    throw new MainnetReconciliationError("REPLACEMENT_CONFLICT", 409);
  }
  return {
    attemptId: input.replacementAttemptId,
    intentId: attempt.intentId,
    status: "submitted",
    reasonCode: "REPLACEMENT_SUBMITTED",
    transactionHash: input.replacementHash,
    blockNumber: null,
    latestNonce: null,
    pendingNonce: null,
    createdAt: replacedAt,
  };
}

function result(
  attempt: MainnetAttempt,
  status: MainnetReconciliation["status"],
  reasonCode: string,
  now: number,
  blockNumber: number | null = attempt.blockNumber,
  latestNonce: number | null = null,
  pendingNonce: number | null = null,
): MainnetReconciliation {
  return {
    attemptId: attempt.attemptId,
    intentId: attempt.intentId,
    status,
    reasonCode,
    transactionHash: attempt.transactionHash,
    blockNumber,
    latestNonce,
    pendingNonce,
    createdAt: now,
  };
}

function existingResult(attempt: MainnetAttempt, now: number): MainnetReconciliation {
  const status = attempt.status === "confirmed"
    ? "confirmed"
    : attempt.status === "replaced"
      ? "replaced"
      : attempt.status === "nonce_conflict"
        ? "quarantined"
        : "failed";
  return result(
    attempt,
    status,
    attempt.finalReason ?? `ATTEMPT_${attempt.status.toUpperCase()}`,
    now,
  );
}

export async function reconcileMainnetAttempt(input: {
  attemptId: string;
  store: MainnetReconciliationStore;
  rpc: MainnetReceiptRpc;
  now?: () => number;
  dropAfterMs?: number;
  missingObservationThreshold?: number;
}): Promise<MainnetReconciliation> {
  const now = input.now ?? Date.now;
  const checkedAt = now();
  const attempt = await input.store.load(input.attemptId);
  if (!attempt) {
    throw new MainnetReconciliationError("MAINNET_ATTEMPT_NOT_FOUND", 404);
  }
  if (attempt.status !== "submitted") return existingResult(attempt, checkedAt);

  const receipt = await input.rpc.getTransactionReceipt(attempt.transactionHash);
  if (receipt) {
    const blockNumber = Number(receipt.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new MainnetReconciliationError("RECEIPT_BLOCK_INVALID", 503);
    }
    const confirmed = receipt.status === "success";
    const reasonCode = confirmed ? "RECEIPT_CONFIRMED" : "RECEIPT_REVERTED";
    const mintedIds = confirmed ? v4MintedTokenIds(receipt.logs, attempt.walletAddress) : [];
    await input.store.finalize({
      attempt,
      attemptStatus: confirmed ? "confirmed" : "reverted",
      intentStatus: confirmed ? "confirmed" : "failed",
      reasonCode,
      blockNumber,
      latestNonce: null,
      pendingNonce: null,
      quarantineWallet: false,
      v4TokenId: mintedIds.length === 1 ? mintedIds[0].toString() : null,
      now: checkedAt,
    });
    return result(
      attempt,
      confirmed ? "confirmed" : "failed",
      reasonCode,
      checkedAt,
      blockNumber,
    );
  }

  const transaction = await input.rpc.getTransaction(attempt.transactionHash);
  if (transaction && transaction.nonce !== attempt.nonce) {
    await input.store.finalize({
      attempt,
      attemptStatus: "nonce_conflict",
      intentStatus: "failed",
      reasonCode: "TRANSACTION_NONCE_MISMATCH",
      blockNumber: null,
      latestNonce: null,
      pendingNonce: null,
      quarantineWallet: true,
      now: checkedAt,
    });
    return result(
      attempt,
      "quarantined",
      "TRANSACTION_NONCE_MISMATCH",
      checkedAt,
    );
  }
  if (transaction) {
    await input.store.observe({
      attempt,
      outcome: "pending",
      reasonCode: "TRANSACTION_PENDING",
      latestNonce: null,
      pendingNonce: null,
      blockNumber: null,
      now: checkedAt,
    });
    return result(attempt, "submitted", "TRANSACTION_PENDING", checkedAt);
  }

  const [latestNonce, pendingNonce] = await Promise.all([
    input.rpc.getTransactionCount(attempt.walletAddress, "latest"),
    input.rpc.getTransactionCount(attempt.walletAddress, "pending"),
  ]);
  if (
    !Number.isSafeInteger(latestNonce) || latestNonce < 0 ||
    !Number.isSafeInteger(pendingNonce) || pendingNonce < latestNonce
  ) {
    throw new MainnetReconciliationError("CHAIN_NONCE_INVALID", 503);
  }

  if (latestNonce > attempt.nonce) {
    await input.store.finalize({
      attempt,
      attemptStatus: "nonce_conflict",
      intentStatus: "failed",
      reasonCode: "NONCE_CONSUMED_BY_UNKNOWN_TRANSACTION",
      blockNumber: null,
      latestNonce,
      pendingNonce,
      quarantineWallet: true,
      now: checkedAt,
    });
    return result(
      attempt,
      "quarantined",
      "NONCE_CONSUMED_BY_UNKNOWN_TRANSACTION",
      checkedAt,
      null,
      latestNonce,
      pendingNonce,
    );
  }

  const missingObservations = attempt.missingObservations + 1;
  const dropAfterMs = input.dropAfterMs ?? 10 * 60_000;
  const missingThreshold = input.missingObservationThreshold ?? 3;
  const shouldDrop =
    checkedAt - attempt.submittedAt >= dropAfterMs &&
    missingObservations >= missingThreshold;
  if (shouldDrop) {
    await input.store.finalize({
      attempt,
      attemptStatus: "dropped",
      intentStatus: "failed",
      reasonCode: "TRANSACTION_DROPPED",
      blockNumber: null,
      latestNonce,
      pendingNonce,
      quarantineWallet: false,
      now: checkedAt,
    });
    return result(
      attempt,
      "failed",
      "TRANSACTION_DROPPED",
      checkedAt,
      null,
      latestNonce,
      pendingNonce,
    );
  }

  await input.store.observe({
    attempt,
    outcome: "pending",
    reasonCode: "TRANSACTION_NOT_FOUND",
    latestNonce,
    pendingNonce,
    blockNumber: null,
    now: checkedAt,
  });
  return result(
    attempt,
    "submitted",
    "TRANSACTION_NOT_FOUND",
    checkedAt,
    null,
    latestNonce,
    pendingNonce,
  );
}
