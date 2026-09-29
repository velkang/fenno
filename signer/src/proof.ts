import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_PROOF_KIND,
  arcTestnetProofPayloadHash,
} from "@actora/chain";
import type {
  Address,
  Hex,
  TransactionSerializableEIP1559,
  TransactionSerializedEIP1559,
} from "viem";
import { keccak256 } from "viem";
import type { EncryptedWallet } from "./crypto";
import type { WalletState } from "./policy";
import { signAllowedTransaction, SigningRejectedError } from "./sign";

export type ProofIntentStatus =
  | "pending"
  | "signing"
  | "submitted"
  | "confirmed"
  | "rejected"
  | "failed"
  | "expired";

export type ProofExecution = {
  intentId: string;
  intentKind: string;
  intentStatus: ProofIntentStatus;
  intentExpiresAt: number;
  payloadHash: Hex;
  transactionHash: Hex | null;
  attemptId: string | null;
  wallet: EncryptedWallet;
  walletState: WalletState;
  verifiedOwnerAddress: Address;
};

export type ProofResult = {
  intentId: string;
  status: "submitted" | "confirmed" | "failed";
  transactionHash: Hex;
  blockNumber?: string;
};

export interface ProofStore {
  getExecution(intentId: string, walletId: string): Promise<ProofExecution | null>;
  reserveNonce(input: {
    execution: ProofExecution;
    nonce: number;
    now: number;
    leaseExpiresAt: number;
  }): Promise<boolean>;
  handoffSubmitted(input: {
    execution: ProofExecution;
    attemptId: string;
    nonce: number;
    transactionHash: Hex;
    now: number;
  }): Promise<boolean>;
  markFinal(input: {
    attemptId: string | null;
    intentId: string;
    status: "confirmed" | "failed";
    transactionHash: Hex;
    blockNumber: bigint;
    reason: string;
    now: number;
  }): Promise<void>;
  markBroadcastFailed(input: {
    attemptId: string;
    execution: ProofExecution;
    transactionHash: Hex;
    reason: string;
    now: number;
  }): Promise<void>;
  reject(input: {
    execution: ProofExecution;
    reason: string;
    now: number;
  }): Promise<void>;
}

export interface ProofRpc {
  getTransactionCount(address: Address): Promise<number>;
  estimateFees(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }>;
  sendRawTransaction(
    serializedTransaction: TransactionSerializedEIP1559,
  ): Promise<Hex>;
  waitForReceipt(transactionHash: Hex): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
  }>;
}

export class ProofExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function reject(
  store: ProofStore,
  execution: ProofExecution,
  reason: string,
  now: number,
): Promise<never> {
  await store.reject({ execution, reason, now });
  throw new ProofExecutionError(reason);
}

export async function executeTestnetProof(
  store: ProofStore,
  rpc: ProofRpc,
  wrappingKeys: ReadonlyMap<number, CryptoKey>,
  input: { intentId: string; walletId: string; now: number },
): Promise<ProofResult> {
  const execution = await store.getExecution(input.intentId, input.walletId);
  if (!execution) throw new ProofExecutionError("PROOF_INTENT_NOT_FOUND");

  if (execution.intentStatus === "confirmed" && execution.transactionHash) {
    return {
      intentId: execution.intentId,
      status: "confirmed",
      transactionHash: execution.transactionHash,
    };
  }
  if (execution.intentStatus === "submitted" && execution.transactionHash) {
    return finalizeReceipt(
      store,
      rpc,
      execution,
      execution.attemptId,
      execution.transactionHash,
      input.now,
    );
  }
  if (execution.intentStatus !== "pending") {
    throw new ProofExecutionError("PROOF_INTENT_NOT_PENDING");
  }
  if (execution.intentExpiresAt <= input.now) {
    return reject(store, execution, "INTENT_EXPIRED", input.now);
  }
  if (execution.intentKind !== ARC_TESTNET_PROOF_KIND) {
    return reject(store, execution, "INTENT_KIND_NOT_ALLOWED", input.now);
  }
  if (
    execution.payloadHash.toLowerCase() !==
    arcTestnetProofPayloadHash({
      walletId: execution.wallet.walletId,
      address: execution.wallet.address,
    }).toLowerCase()
  ) {
    return reject(store, execution, "INTENT_PAYLOAD_MISMATCH", input.now);
  }

  const wrappingKey = wrappingKeys.get(execution.wallet.keyVersion);
  if (!wrappingKey) {
    return reject(store, execution, "KEY_VERSION_UNAVAILABLE", input.now);
  }

  const [nonce, fees] = await Promise.all([
    rpc.getTransactionCount(execution.wallet.address),
    rpc.estimateFees(),
  ]);
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n) {
    return reject(store, execution, "FEE_ESTIMATE_INVALID", input.now);
  }
  if (!(await store.reserveNonce({
    execution,
    nonce,
    now: input.now,
    leaseExpiresAt: input.now + 30_000,
  }))) {
    throw new ProofExecutionError("WALLET_EXECUTION_BUSY");
  }

  const transaction: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: ARC_TESTNET_CHAIN_ID,
    to: execution.wallet.address,
    data: "0x",
    value: 0n,
    nonce,
    gas: 21_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  let signed: TransactionSerializedEIP1559;
  try {
    signed = await signAllowedTransaction(
      execution.wallet,
      wrappingKey,
      {
        intentId: execution.intentId,
        intentStatus: "pending",
        intentExpiresAt: execution.intentExpiresAt,
        chainId: ARC_TESTNET_CHAIN_ID,
        to: execution.wallet.address,
        data: "0x",
        value: 0n,
        walletState: execution.walletState,
        verifiedOwnerAddress: execution.verifiedOwnerAddress,
      },
      {
        chainId: ARC_TESTNET_CHAIN_ID,
        allowedCalls: new Map([
          [execution.wallet.address.toLowerCase(), new Set<Hex>(["0x"])],
        ]),
        now: input.now,
        emergencyStop: false,
      },
      transaction,
    );
  } catch (error) {
    return reject(
      store,
      execution,
      error instanceof SigningRejectedError ? error.reason : "SIGNING_FAILED",
      input.now,
    );
  }

  const expectedTransactionHash = keccak256(signed);
  const attemptId = `testnet_attempt_${execution.intentId}`;
  if (!(await store.handoffSubmitted({
    execution,
    attemptId,
    nonce,
    transactionHash: expectedTransactionHash,
    now: input.now,
  }))) {
    throw new ProofExecutionError("SUBMISSION_HANDOFF_CONFLICT");
  }

  let transactionHash: Hex;
  try {
    transactionHash = await rpc.sendRawTransaction(signed);
  } catch (error) {
    if (error instanceof Error && /insufficient funds/i.test(error.message)) {
      await store.markBroadcastFailed({
        attemptId,
        execution,
        transactionHash: expectedTransactionHash,
        reason: "TESTNET_WALLET_NEEDS_GAS",
        now: input.now,
      });
      throw new ProofExecutionError("TESTNET_WALLET_NEEDS_GAS");
    }
    return {
      intentId: execution.intentId,
      status: "submitted",
      transactionHash: expectedTransactionHash,
    };
  }
  if (transactionHash.toLowerCase() !== expectedTransactionHash.toLowerCase()) {
    throw new ProofExecutionError("BROADCAST_HASH_MISMATCH");
  }
  return finalizeReceipt(
    store,
    rpc,
    execution,
    attemptId,
    transactionHash,
    input.now,
  );
}

async function finalizeReceipt(
  store: ProofStore,
  rpc: ProofRpc,
  execution: ProofExecution,
  attemptId: string | null,
  transactionHash: Hex,
  now: number,
): Promise<ProofResult> {
  try {
    const receipt = await rpc.waitForReceipt(transactionHash);
    const status = receipt.status === "success" ? "confirmed" : "failed";
    await store.markFinal({
      attemptId,
      intentId: execution.intentId,
      status,
      transactionHash,
      blockNumber: receipt.blockNumber,
      reason: status === "confirmed" ? "RECEIPT_CONFIRMED" : "RECEIPT_REVERTED",
      now,
    });
    return {
      intentId: execution.intentId,
      status,
      transactionHash,
      blockNumber: receipt.blockNumber.toString(),
    };
  } catch {
    return {
      intentId: execution.intentId,
      status: "submitted",
      transactionHash,
    };
  }
}
