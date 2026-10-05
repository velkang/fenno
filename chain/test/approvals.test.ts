import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  UNISWAP_V3_ARC,
  approvalPayloadHash,
  buildApproval,
  simulateApproval,
  type ApprovalSimulationClient,
} from "../src";

const approveAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const owner = "0x1111111111111111111111111111111111111111" as const;

describe("approvals", () => {
  it("builds an exact approval to the position manager unless told otherwise", () => {
    const approval = buildApproval({ tokenAddress: ARC_TOKENS.USDC.address, tokenSymbol: "USDC", amount: 1_500_000n });
    const decoded = decodeFunctionData({ abi: approveAbi, data: approval.data });

    expect(approval).toMatchObject({
      chainId: ARC_CHAIN_ID,
      tokenAddress: ARC_TOKENS.USDC.address,
      to: ARC_TOKENS.USDC.address,
      spender: UNISWAP_V3_ARC.nonfungiblePositionManager.address,
      amount: 1_500_000n,
      value: 0n,
    });
    expect(decoded.args).toEqual([
      UNISWAP_V3_ARC.nonfungiblePositionManager.address,
      1_500_000n,
    ]);
    expect(approvalPayloadHash(approval)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([0n, -1n])("rejects unsafe approval amount %s", (amount) => {
    expect(() => buildApproval({ tokenAddress: ARC_TOKENS.USDC.address, amount })).toThrow(
      "Approval amount is outside uint256 range",
    );
  });

  it("simulates at the selected block and estimates gas without sending", async () => {
    const calls: unknown[] = [];
    const client = {
      simulateContract: async (parameters: unknown) => {
        calls.push(parameters);
        return { result: true };
      },
      estimateGas: async (parameters: unknown) => {
        calls.push(parameters);
        return 45_000n;
      },
    } as unknown as ApprovalSimulationClient;
    const approval = buildApproval({ tokenAddress: ARC_TOKENS.cirBTC.address, amount: 10n });

    const result = await simulateApproval({
      client,
      owner,
      approval,
      blockNumber: 99n,
    });

    expect(result).toEqual({ gasEstimate: "45000", blockNumber: "99" });
    expect(calls).toHaveLength(2);
    expect(calls).toEqual([
      expect.objectContaining({ account: owner, blockNumber: 99n }),
      expect.objectContaining({ account: owner, blockNumber: 99n }),
    ]);
  });
});
