import type {
  TransactionSerializableEIP1559,
  TransactionSerializedEIP1559,
} from "viem";
import { withManagedAccount, type EncryptedWallet } from "./crypto";
import {
  validateSigningRequest,
  type SigningPolicy,
  type SigningRequest,
} from "./policy";

export class SigningRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function signAllowedTransaction(
  wallet: EncryptedWallet,
  wrappingKey: CryptoKey,
  request: SigningRequest,
  policy: SigningPolicy,
  transaction: TransactionSerializableEIP1559,
): Promise<TransactionSerializedEIP1559> {
  if (
    transaction.chainId !== request.chainId ||
    transaction.to?.toLowerCase() !== request.to.toLowerCase() ||
    (transaction.data ?? "0x").toLowerCase() !== request.data.toLowerCase() ||
    (transaction.value ?? 0n) !== request.value
  ) {
    throw new SigningRejectedError("TRANSACTION_INTENT_MISMATCH");
  }

  const decision = validateSigningRequest(request, policy);
  if (!decision.allowed) throw new SigningRejectedError(decision.reason);

  return withManagedAccount(wallet, wrappingKey, async (account) => {
    const signed = await account.signTransaction(transaction);
    if (!signed.startsWith("0x02")) {
      throw new SigningRejectedError("TRANSACTION_TYPE_INVALID");
    }
    return signed as TransactionSerializedEIP1559;
  });
}
