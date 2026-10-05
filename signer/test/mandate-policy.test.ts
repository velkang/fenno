import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { validateMandate, type MandateRequest } from "../src/mandate-policy";

const poolId = `0x${"11".repeat(32)}` as Hex;
const otherPool = `0x${"22".repeat(32)}` as Hex;

function request(overrides: Partial<MandateRequest> = {}): MandateRequest {
  return {
    automation: {
      runId: "run-1",
      runStatus: "running",
      mandate: { status: "active", poolId, maxPositionUsd: 100, maxRunsPerDay: 3 },
      runsStartedToday: 1,
    },
    kind: "v4_position_mint",
    walletState: "active",
    poolId,
    value: { usdc: 50_000_000n, usdcDecimals: 6 },
    ...overrides,
  };
}

const withAutomation = (changes: Partial<MandateRequest["automation"]>) =>
  request({ automation: { ...request().automation, ...changes } });

describe("mandate policy for agent requests", () => {
  it("allows a request inside an active mandate and a running run", () => {
    expect(validateMandate(request())).toEqual({ allowed: true, reason: "POLICY_ALLOWED" });
  });

  it("rejects a run that is not running, including one the user has not approved", () => {
    expect(validateMandate(withAutomation({ runStatus: "proposed" })).reason).toBe("MANDATE_RUN_NOT_RUNNING");
    expect(validateMandate(withAutomation({ runStatus: null })).reason).toBe("MANDATE_RUN_NOT_RUNNING");
  });

  it("rejects a revoked, paused or missing mandate", () => {
    const mandate = request().automation.mandate!;
    expect(validateMandate(withAutomation({ mandate: { ...mandate, status: "revoked" } })).reason)
      .toBe("MANDATE_NOT_ACTIVE");
    expect(validateMandate(withAutomation({ mandate: { ...mandate, status: "paused" } })).reason)
      .toBe("MANDATE_NOT_ACTIVE");
    expect(validateMandate(withAutomation({ mandate: null })).reason).toBe("MANDATE_NOT_ACTIVE");
  });

  it("rejects a wallet that is not active, even for closing a position", () => {
    expect(validateMandate(request({ walletState: "paused", kind: "v4_position_withdraw", value: undefined })).reason)
      .toBe("MANDATE_WALLET_NOT_ACTIVE");
  });

  it("rejects anything but approving, swapping, opening, collecting and closing", () => {
    for (const kind of ["usdc_withdrawal", "position_increase", "position_decrease"] as const) {
      expect(validateMandate(request({ kind })).reason).toBe("MANDATE_KIND_NOT_ALLOWED");
    }
  });

  it("holds a v3 position's actions to the mandate's pool and limit", () => {
    const v3Pool = "0x3333333333333333333333333333333333333333" as Hex;
    const v3 = (changes: Partial<MandateRequest>) => validateMandate(request({
      automation: { ...request().automation, mandate: { ...request().automation.mandate!, poolId: v3Pool } },
      poolId: v3Pool, ...changes }));
    for (const kind of ["erc20_approval", "position_collect", "position_withdraw"] as const) {
      expect(v3({ kind, value: undefined }).allowed).toBe(true);
    }
    for (const kind of ["single_pool_swap", "position_mint"] as const) {
      expect(v3({ kind }).allowed).toBe(true);
      expect(v3({ kind, value: undefined }).reason).toBe("MANDATE_VALUE_UNKNOWN");
      expect(v3({ kind, value: { usdc: 100_000_001n, usdcDecimals: 6 } }).reason).toBe("MANDATE_VALUE_EXCEEDS_LIMIT");
    }
    // Addresses compare without regard to letter case.
    expect(v3({ kind: "position_mint", poolId: v3Pool.toUpperCase().replace("0X", "0x") as Hex }).allowed).toBe(true);
    expect(v3({ kind: "position_mint", poolId: "0x4444444444444444444444444444444444444444" }).reason)
      .toBe("MANDATE_POOL_NOT_ALLOWED");
  });

  it("rejects another pool", () => {
    expect(validateMandate(request({ poolId: otherPool })).reason).toBe("MANDATE_POOL_NOT_ALLOWED");
    expect(validateMandate(request({ poolId: undefined })).reason).toBe("MANDATE_POOL_NOT_ALLOWED");
  });

  it("rejects a mint or swap above the mandate's limit, or of unknown value", () => {
    expect(validateMandate(request({ value: { usdc: 100_000_001n, usdcDecimals: 6 } })).reason)
      .toBe("MANDATE_VALUE_EXCEEDS_LIMIT");
    expect(validateMandate(request({ value: { usdc: 100n * 10n ** 18n, usdcDecimals: 18 } })).allowed)
      .toBe(true);
    expect(validateMandate(request({ kind: "v4_single_pool_swap", value: undefined })).reason)
      .toBe("MANDATE_VALUE_UNKNOWN");
    // Approvals, collecting and closing move nothing into the pool.
    expect(validateMandate(request({ kind: "v4_approval", value: undefined })).allowed).toBe(true);
    expect(validateMandate(request({ kind: "v4_position_collect", value: undefined })).allowed).toBe(true);
  });

  it("rejects once more runs started in a day than the mandate allows", () => {
    expect(validateMandate(withAutomation({ runsStartedToday: 3 })).allowed).toBe(true);
    expect(validateMandate(withAutomation({ runsStartedToday: 4 })).reason).toBe("MANDATE_DAILY_LIMIT_REACHED");
  });
});
