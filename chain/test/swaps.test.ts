import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_TOKENS, UNISWAP_SWAP_ARC, buildSwap, quoteSwap, swapRouterAbi } from "../src";

const token = getAddress("0x2222222222222222222222222222222222222222");
const pool = getAddress("0x3333333333333333333333333333333333333333");
const wallet = getAddress("0x1111111111111111111111111111111111111111");

describe("single-pool Arc swap", () => {
  it("quotes an exact input at a fixed block", async () => {
    const calls: unknown[] = [];
    const result = await quoteSwap({
      client: { async simulateContract(parameters) {
        calls.push(parameters);
        return { result: [975n, 1n, 0, 20_000n] as const };
      } },
      pool: { fee: 3000 }, account: wallet, tokenIn: ARC_TOKENS.USDC.address,
      tokenOut: token, amountIn: 1_000_000n, blockNumber: 42n,
    });
    expect(result).toEqual({ amountOut: 975n, gasEstimate: 20_000n });
    expect(calls[0]).toMatchObject({ address: UNISWAP_SWAP_ARC.quoterV2,
      blockNumber: 42n });
  });

  it("encodes one deadline-bound swap with an exact recipient and minimum output", () => {
    const swap = buildSwap({ poolAddress: pool, poolFee: 3000,
      tokenIn: ARC_TOKENS.USDC.address, tokenOut: token,
      recipient: wallet, amountIn: 1_000_000n,
      amountOutMinimum: 950n, deadline: 2_000_000_600n });
    expect(swap.to).toBe(UNISWAP_SWAP_ARC.swapRouter02);
    const outer = decodeFunctionData({ abi: swapRouterAbi, data: swap.data });
    expect(outer.functionName).toBe("multicall");
    if (outer.functionName !== "multicall") return;
    expect(outer.args[0]).toBe(swap.deadline);
    expect(outer.args[1]).toHaveLength(1);
    const inner = decodeFunctionData({ abi: swapRouterAbi, data: outer.args[1][0] });
    expect(inner.functionName).toBe("exactInputSingle");
    if (inner.functionName === "exactInputSingle") {
      expect(inner.args[0]).toMatchObject({ recipient: wallet,
        amountIn: 1_000_000n, amountOutMinimum: 950n });
    }
  });
});
