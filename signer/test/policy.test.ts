import { describe, expect, it } from "vitest";
import { validateSigningRequest, type SigningRequest } from "../src/policy";

const target = "0x1111111111111111111111111111111111111111" as const;
const owner = "0x2222222222222222222222222222222222222222" as const;
const selector = "0x12345678" as const;
const now = 1_800_000_000;

const request: SigningRequest = {
  intentId: "intent-1",
  intentStatus: "pending",
  intentExpiresAt: now + 60,
  chainId: 5_042_002,
  to: target,
  data: `${selector}00` as const,
  value: 0n,
  walletState: "active",
  verifiedOwnerAddress: owner,
};

const policy = {
  chainId: 5_042_002,
  allowedCalls: new Map([[target, new Set([selector])]]),
  now,
  emergencyStop: false,
};

describe("signing policy", () => {
  it("allows an exact allowlisted call", () => {
    expect(validateSigningRequest(request, policy)).toEqual({
      allowed: true,
      reason: "POLICY_ALLOWED",
    });
  });

  it.each([
    [{ walletState: "paused" as const }, "WALLET_NOT_SIGNABLE"],
    [{ intentStatus: "submitted" as const }, "INTENT_NOT_PENDING"],
    [{ intentExpiresAt: now }, "INTENT_EXPIRED"],
    [{ chainId: 1 }, "CHAIN_NOT_ALLOWED"],
    [
      { to: "0x3333333333333333333333333333333333333333" as const },
      "TARGET_NOT_ALLOWED",
    ],
    [{ data: "0x87654321" as const }, "SELECTOR_NOT_ALLOWED"],
    [
      {
        withdrawalRecipient:
          "0x3333333333333333333333333333333333333333" as const,
      },
      "WITHDRAWAL_RECIPIENT_NOT_OWNER",
    ],
  ])("rejects a request outside policy", (overrides, reason) => {
    expect(validateSigningRequest({ ...request, ...overrides }, policy)).toEqual({
      allowed: false,
      reason,
    });
  });
});
