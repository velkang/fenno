import {
  ARC_CHAIN_ID,
} from "@actora/chain";
import {
  keccak256,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559,
} from "viem";
import { withManagedAccount } from "./crypto";
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
  getWrappingKeys: () => Promise<ReadonlyMap<number, CryptoKey>>;
  limits: { maxUsdc: bigint; maxCirBtc: bigint };
  maxTransactionFee: bigint;
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
    limits: input.limits,
    emergencyStop: input.emergencyStop,
    now,
  });
  if (evaluation.decision !== "allowed") {
    throw new MainnetExecutionError(evaluation.reasonCode, 422);
  }
  if (!loaded.encryptedWallet) {
    throw new MainnetExecutionError("ENCRYPTED_WALLET_UNAVAILABLE", 500);
  }
  const wrappingKey = (await input.getWrappingKeys()).get(
    loaded.encryptedWallet.keyVersion,
  );
  if (!wrappingKey) {
    throw new MainnetExecutionError("KEY_VERSION_UNAVAILABLE", 503);
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
  if (
    input.maxTransactionFee < 0n ||
    gasLimit * fees.maxFeePerGas > input.maxTransactionFee
  ) {
    throw new MainnetExecutionError("GAS_FEE_CAP_EXCEEDED", 422);
  }
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
    walletId: loaded.encryptedWallet.walletId,
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
    signed = await withManagedAccount(
      loaded.encryptedWallet,
      wrappingKey,
      (account) => account.signTransaction(transaction),
    ) as TransactionSerializedEIP1559;
  } catch {
    await input.reservationStore.release({
      intentId: loaded.intentId,
      walletId: loaded.encryptedWallet.walletId,
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
