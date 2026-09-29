import type { Address, Hex } from "viem";

export type WalletState =
  | "provisioning"
  | "active"
  | "paused"
  | "withdrawing"
  | "closed"
  | "quarantined";

export type SigningRequest = {
  intentId: string;
  intentStatus: "pending" | "signing" | "submitted" | "confirmed" | "rejected" | "failed" | "expired";
  intentExpiresAt: number;
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  walletState: WalletState;
  withdrawalRecipient?: Address;
  verifiedOwnerAddress: Address;
};

export type SigningPolicy = {
  chainId: number;
  allowedCalls: ReadonlyMap<string, ReadonlySet<Hex>>;
  now: number;
  emergencyStop: boolean;
};

export type PolicyDecision =
  | { allowed: true; reason: "POLICY_ALLOWED" }
  | { allowed: false; reason: string };

function reject(reason: string): PolicyDecision {
  return { allowed: false, reason };
}

export function validateSigningRequest(
  request: SigningRequest,
  policy: SigningPolicy,
): PolicyDecision {
  if (policy.emergencyStop) return reject("EMERGENCY_STOP_ACTIVE");
  if (request.walletState !== "active" && request.walletState !== "withdrawing") {
    return reject("WALLET_NOT_SIGNABLE");
  }
  if (request.intentStatus !== "pending") return reject("INTENT_NOT_PENDING");
  if (request.intentExpiresAt <= policy.now) return reject("INTENT_EXPIRED");
  if (request.chainId !== policy.chainId) return reject("CHAIN_NOT_ALLOWED");
  if (request.value < 0n) return reject("VALUE_INVALID");

  if (
    request.withdrawalRecipient &&
    request.withdrawalRecipient.toLowerCase() !==
      request.verifiedOwnerAddress.toLowerCase()
  ) {
    return reject("WITHDRAWAL_RECIPIENT_NOT_OWNER");
  }

  const selectors = policy.allowedCalls.get(request.to.toLowerCase());
  if (!selectors) return reject("TARGET_NOT_ALLOWED");

  const selector = (request.data.length >= 10
    ? request.data.slice(0, 10)
    : "0x") as Hex;
  if (!selectors.has(selector)) return reject("SELECTOR_NOT_ALLOWED");

  return { allowed: true, reason: "POLICY_ALLOWED" };
}
