import {
  ARC_CHAIN_ID,
} from "@stillwater/chain";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559,
} from "viem";
import {
  evaluateLoadedMainnetIntent,
  type MainnetAuditClient,
  type MainnetEvaluationStore,
} from "./mainnet-evaluator";
import type { ExecutionRehearsalStore } from "./mainnet-rehearsal";
import {
  handoffMainnetSubmission,
  type MainnetSubmissionStore,
} from "./mainnet-submission";

export type MainnetExecutionResult = {
  attemptId: string;
  intentId: string;
  status: "submitted";
  transactionHash: Hex;
  nonce: number;
};

export type MainnetExecutionRpc = MainnetAuditClient & {
  // Required here: v3 swaps, approvals and mints fail revalidation without it.
  getCode(parameters: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getBalance?(input: { address: Address }): Promise<bigint>;
  getTransactionCount(input: {
    address: Address;
    blockTag: "pending";
  }): Promise<number>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>;
  estimateGas(input: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
  }): Promise<bigint>;
  sendRawTransaction(input: {
    serializedTransaction: TransactionSerializedEIP1559;
  }): Promise<Hex>;
};

export class MainnetExecutionError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function executeMainnetIntent(input: {
  intentId: string;
  evaluationStore: MainnetEvaluationStore;
  reservationStore: Pick<ExecutionRehearsalStore, "reserve" | "release">;
  submissionStore: MainnetSubmissionStore;
  rpc: MainnetExecutionRpc;
  /** Signs with the custody provider (Circle) and returns the serialized transaction. */
  signTransaction: (circleWalletId: string, transaction: TransactionSerializableEIP1559) => Promise<Hex>;
  emergencyStop: boolean;
  now?: () => number;
}): Promise<MainnetExecutionResult> {
  const now = input.now ?? Date.now;
  const loaded = await input.evaluationStore.load(input.intentId);
  if (!loaded) {
    throw new MainnetExecutionError("MAINNET_INTENT_NOT_FOUND", 404);
  }

  const evaluation = await evaluateLoadedMainnetIntent({
    loaded,
    store: input.evaluationStore,
    client: input.rpc,
    emergencyStop: input.emergencyStop,
    now,
  });
  if (evaluation.decision !== "allowed") {
    throw new MainnetExecutionError(evaluation.reasonCode, 422);
  }
  const custody = loaded.custody;
  if (!custody) {
    throw new MainnetExecutionError("CUSTODY_WALLET_UNAVAILABLE", 500);
  }

  const [nonce, fees, estimatedGas] = await Promise.all([
    input.rpc.getTransactionCount({
      address: loaded.wallet.address,
      blockTag: "pending",
    }),
    input.rpc.estimateFeesPerGas(),
    input.rpc.estimateGas({
      account: loaded.wallet.address,
      to: loaded.transaction.to,
      data: loaded.transaction.data,
      value: loaded.transaction.value,
    }),
  ]);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new MainnetExecutionError("PENDING_NONCE_INVALID", 503);
  }
  if (
    fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n ||
    fees.maxPriorityFeePerGas > fees.maxFeePerGas
  ) {
    throw new MainnetExecutionError("FEE_ESTIMATE_INVALID", 503);
  }
  if (estimatedGas <= 0n) {
    throw new MainnetExecutionError("GAS_ESTIMATE_INVALID", 503);
  }
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  if (loaded.kind === "usdc_withdrawal") {
    if (!loaded.withdrawal || !input.rpc.getBalance) {
      throw new MainnetExecutionError("WITHDRAWAL_BALANCE_UNAVAILABLE", 503);
    }
    const balance = await input.rpc.getBalance({ address: loaded.wallet.address });
    if (balance < loaded.withdrawal.transaction.amount * 1_000_000_000_000n +
      gasLimit * fees.maxFeePerGas) {
      throw new MainnetExecutionError("INSUFFICIENT_USDC_AFTER_FEES", 422);
    }
  }
  // A token withdrawal moves no USDC, but the network fee is still paid in it.
  if (loaded.kind === "token_withdrawal") {
    if (!input.rpc.getBalance) throw new MainnetExecutionError("WITHDRAWAL_BALANCE_UNAVAILABLE", 503);
    const balance = await input.rpc.getBalance({ address: loaded.wallet.address });
    if (balance < gasLimit * fees.maxFeePerGas) throw new MainnetExecutionError("INSUFFICIENT_USDC_AFTER_FEES", 422);
  }
  if ((loaded.kind === "v4_position_mint" || loaded.kind === "v4_single_pool_swap") &&
      loaded.transaction.value > 0n) {
    if (!input.rpc.getBalance) {
      throw new MainnetExecutionError("V4_MINT_BALANCE_UNAVAILABLE", 503);
    }
    const balance = await input.rpc.getBalance({ address: loaded.wallet.address });
    if (balance < loaded.transaction.value + gasLimit * fees.maxFeePerGas) {
      throw new MainnetExecutionError("INSUFFICIENT_USDC_AFTER_FEES", 422);
    }
  }

  const reservedAt = now();
  if (!(await input.reservationStore.reserve({
    intentId: loaded.intentId,
    walletId: custody.walletId,
    nonce,
    now: reservedAt,
    leaseExpiresAt: reservedAt + 30_000,
  }))) {
    throw new MainnetExecutionError("WALLET_EXECUTION_BUSY", 409);
  }

  const transaction: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: ARC_CHAIN_ID,
    to: loaded.transaction.to,
    data: loaded.transaction.data,
    value: loaded.transaction.value,
    nonce,
    gas: gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };

  let signed: TransactionSerializedEIP1559;
  try {
    signed = await input.signTransaction(custody.circleWalletId, transaction) as TransactionSerializedEIP1559;
    // Never broadcast what we did not build: the remote signature must cover
    // exactly this transaction and come from this wallet.
    if (!(await signedAsBuilt(signed, transaction, custody.address))) {
      throw new Error("SIGNED_TRANSACTION_MISMATCH");
    }
  } catch {
    await input.reservationStore.release({
      intentId: loaded.intentId,
      walletId: custody.walletId,
      nonce,
      now: now(),
    });
    throw new MainnetExecutionError("MAINNET_SIGNING_FAILED", 500);
  }

  const transactionHash = keccak256(signed);
  const attemptId = `mainnet_attempt_${crypto.randomUUID()}`;
  await handoffMainnetSubmission({
    attemptId,
    intentId: loaded.intentId,
    signedNonce: nonce,
    transactionHash,
    store: input.submissionStore,
    now,
  });

  let returnedHash: Hex;
  try {
    returnedHash = await input.rpc.sendRawTransaction({
      serializedTransaction: signed,
    });
  } catch {
    return {
      attemptId,
      intentId: loaded.intentId,
      status: "submitted",
      transactionHash,
      nonce,
    };
  }
  if (returnedHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new MainnetExecutionError("BROADCAST_HASH_MISMATCH", 502);
  }
  return {
    attemptId,
    intentId: loaded.intentId,
    status: "submitted",
    transactionHash,
    nonce,
  };
}

async function signedAsBuilt(
  signed: TransactionSerializedEIP1559,
  built: TransactionSerializableEIP1559,
  wallet: Address,
): Promise<boolean> {
  // parseTransaction leaves zero-valued fields out, so compare with defaults.
  const parsed = parseTransaction(signed);
  const same = parsed.type === "eip1559" &&
    parsed.chainId === built.chainId &&
    (parsed.nonce ?? 0) === (built.nonce ?? 0) &&
    parsed.to?.toLowerCase() === built.to?.toLowerCase() &&
    (parsed.data ?? "0x").toLowerCase() === (built.data ?? "0x").toLowerCase() &&
    (parsed.value ?? 0n) === (built.value ?? 0n) &&
    (parsed.gas ?? 0n) === (built.gas ?? 0n) &&
    (parsed.maxFeePerGas ?? 0n) === (built.maxFeePerGas ?? 0n) &&
    (parsed.maxPriorityFeePerGas ?? 0n) === (built.maxPriorityFeePerGas ?? 0n) &&
    (parsed.accessList ?? []).length === 0;
  if (!same) return false;
  const signer = await recoverTransactionAddress({ serializedTransaction: signed });
  return signer.toLowerCase() === wallet.toLowerCase();
}
