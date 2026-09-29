import type { Address } from "viem";
import type { MainnetEvaluation } from "./mainnet-evaluator";

export type RehearsalWallet = {
  walletId: string;
  address: Address;
};

export type ExecutionRehearsal = {
  intentId: string;
  walletId: string;
  decision: "ready" | "rejected";
  reasonCode: string;
  observedPendingNonce: number | null;
  createdAt: number;
};

export interface ExecutionRehearsalStore {
  getWallet(intentId: string): Promise<RehearsalWallet | null>;
  reserve(input: {
    intentId: string;
    walletId: string;
    nonce: number;
    now: number;
    leaseExpiresAt: number;
  }): Promise<boolean>;
  release(input: {
    intentId: string;
    walletId: string;
    nonce: number;
    now: number;
  }): Promise<void>;
  save(result: ExecutionRehearsal): Promise<void>;
}

export interface PendingNonceRpc {
  getTransactionCount(input: {
    address: Address;
    blockTag: "pending";
  }): Promise<number>;
}

export class MainnetRehearsalError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function rehearseMainnetExecution(input: {
  intentId: string;
  evaluate: () => Promise<MainnetEvaluation>;
  store: ExecutionRehearsalStore;
  rpc: PendingNonceRpc;
  now?: () => number;
}): Promise<ExecutionRehearsal> {
  const now = input.now ?? Date.now;
  const wallet = await input.store.getWallet(input.intentId);
  if (!wallet) throw new MainnetRehearsalError("REHEARSAL_INTENT_NOT_FOUND", 404);

  const evaluation = await input.evaluate();
  if (evaluation.decision !== "allowed") {
    const rejected: ExecutionRehearsal = {
      intentId: input.intentId,
      walletId: wallet.walletId,
      decision: "rejected",
      reasonCode: evaluation.reasonCode,
      observedPendingNonce: null,
      createdAt: now(),
    };
    await input.store.save(rejected);
    return rejected;
  }

  const nonce = await input.rpc.getTransactionCount({
    address: wallet.address,
    blockTag: "pending",
  });
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new MainnetRehearsalError("PENDING_NONCE_INVALID", 503);
  }
  const reservedAt = now();
  const reserved = await input.store.reserve({
    intentId: input.intentId,
    walletId: wallet.walletId,
    nonce,
    now: reservedAt,
    leaseExpiresAt: reservedAt + 30_000,
  });
  if (!reserved) {
    const busy: ExecutionRehearsal = {
      intentId: input.intentId,
      walletId: wallet.walletId,
      decision: "rejected",
      reasonCode: "WALLET_EXECUTION_BUSY",
      observedPendingNonce: nonce,
      createdAt: now(),
    };
    await input.store.save(busy);
    return busy;
  }

  const ready: ExecutionRehearsal = {
    intentId: input.intentId,
    walletId: wallet.walletId,
    decision: "ready",
    reasonCode: "REHEARSAL_READY",
    observedPendingNonce: nonce,
    createdAt: now(),
  };
  try {
    await input.store.save(ready);
    return ready;
  } finally {
    await input.store.release({
      intentId: input.intentId,
      walletId: wallet.walletId,
      nonce,
      now: now(),
    });
  }
}
