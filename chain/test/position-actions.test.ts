import {
  decodeFunctionData,
  encodeFunctionResult,
  maxUint128,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  UNISWAP_V3_ARC,
  buildCollectAll,
  buildFullWithdrawal,
  buildIncreaseLiquidity,
  simulatePositionAction,
  type PositionActionClient,
} from "../src";

const owner = "0x1111111111111111111111111111111111111111" as const;
const abi = parseAbi([
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

describe("position action construction", () => {
  it("builds a bounded increase to the pinned manager", () => {
    const action = buildIncreaseLiquidity({
      tokenId: 7n,
      recipient: owner,
      amountCirBtc: 1_000n,
      amountUsdc: 2_000n,
      slippageBps: 100,
      deadline: 2_000_000_000n,
    });
    const decoded = decodeFunctionData({ abi, data: action.data });

    expect(action.to).toBe(UNISWAP_V3_ARC.nonfungiblePositionManager.address);
    expect(action.value).toBe(0n);
    expect(decoded.args[0]).toMatchObject({
      tokenId: 7n,
      amount0Min: 990n,
      amount1Min: 1_980n,
    });
  });

  it("collects every owed token only to the managed wallet", () => {
    const action = buildCollectAll({ tokenId: 7n, recipient: owner });
    const decoded = decodeFunctionData({ abi, data: action.data });

    expect(decoded.args[0]).toEqual({
      tokenId: 7n,
      recipient: owner,
      amount0Max: maxUint128,
      amount1Max: maxUint128,
    });
  });

  it("builds full withdrawal as decrease, collect, then burn", () => {
    const action = buildFullWithdrawal({
      tokenId: 7n,
      recipient: owner,
      liquidity: 500n,
      expectedCirBtc: 100n,
      expectedUsdc: 200n,
      slippageBps: 100,
      deadline: 2_000_000_000n,
    });
    const multicall = decodeFunctionData({ abi, data: action.data });
    const calls = multicall.args[0] as readonly `0x${string}`[];

    expect(calls).toHaveLength(3);
    expect(calls.map((data) => decodeFunctionData({ abi, data }).functionName))
      .toEqual(["decreaseLiquidity", "collect", "burn"]);
  });

  it("decodes simulation output without broadcasting", async () => {
    const action = buildIncreaseLiquidity({
      tokenId: 7n,
      recipient: owner,
      amountCirBtc: 100n,
      amountUsdc: 200n,
      slippageBps: 0,
      deadline: 2_000_000_000n,
    });
    const client = {
      call: async () => ({
        data: encodeFunctionResult({
          abi,
          functionName: "increaseLiquidity",
          result: [300n, 90n, 180n],
        }),
      }),
      estimateGas: async () => 225_000n,
    } satisfies PositionActionClient;

    await expect(simulatePositionAction({
      client,
      owner,
      action,
      blockNumber: 99n,
    })).resolves.toEqual({
      blockNumber: "99",
      gasEstimate: "225000",
      output: {
        liquidity: "300",
        amountCirBtc: "90",
        amountUsdc: "180",
      },
    });
  });
});
