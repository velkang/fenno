import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_TOKENS,
  UNISWAP_V3_ARC,
  buildMint,
  mintPayloadHash,
  simulateMint,
  verifyV3Position,
  type ApprovalSimulationClient,
  type ChainReadClient,
} from "../src";

const owner = "0x1111111111111111111111111111111111111111" as const;
const mintAbi = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
]);

// The cirBTC/USDC 0.01% pool, as an ordinary selected pool.
const cirbtcPool = {
  address: "0x82916BeE18fcef517b26c72d7CB5F13694E1Db41" as const,
  token0: { ...ARC_TOKENS.cirBTC },
  token1: { ...ARC_TOKENS.USDC },
  fee: 100,
  tickSpacing: 1,
};

describe("v3 position actions", () => {
  it("builds a mint with bounded slippage and exact recipient", () => {
    const mint = buildMint({
      pool: cirbtcPool,
      recipient: owner,
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 100_000_000n,
      amount1Desired: 10_000_000n,
      slippageBps: 100,
      deadline: 2_000_000_000n,
    });
    const decoded = decodeFunctionData({ abi: mintAbi, data: mint.data });
    const parameters = decoded.args[0];

    expect(mint.to).toBe(UNISWAP_V3_ARC.nonfungiblePositionManager.address);
    expect(mint.value).toBe(0n);
    expect(mint.amount0Min).toBe(99_000_000n);
    expect(mint.amount1Min).toBe(9_900_000n);
    expect(parameters).toMatchObject({
      token0: ARC_TOKENS.cirBTC.address,
      token1: ARC_TOKENS.USDC.address,
      fee: 100,
      recipient: owner,
    });
    expect(mintPayloadHash(mint)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("builds a generic mint for a selected pool regardless of token ordering", () => {
    const generic = buildMint({
      pool: {
        address: "0x3333333333333333333333333333333333333333",
        token0: { address: ARC_TOKENS.USDC.address, symbol: "USDC", decimals: 6 },
        token1: { address: "0x2222222222222222222222222222222222222222", symbol: "MEME", decimals: 18 },
        fee: 500,
        tickSpacing: 10,
      },
      recipient: owner,
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 1_000_000n,
      amount1Desired: 1_000_000_000_000_000n,
      slippageBps: 100,
      deadline: 2_000_000_000n,
    });
    expect(generic.token0).toBe(ARC_TOKENS.USDC.address);
    expect(generic.token1).toBe("0x2222222222222222222222222222222222222222");
    expect(generic.amount0Min).toBe(990_000n);
  });

  it("rejects invalid ranges, empty amounts, and excessive slippage", () => {
    const base = {
      pool: cirbtcPool,
      recipient: owner,
      tickLower: -100,
      tickUpper: 100,
      amount0Desired: 1n,
      amount1Desired: 1n,
      slippageBps: 100,
      deadline: 1n,
    };
    expect(() => buildMint({ ...base, tickLower: 100 })).toThrow();
    expect(() => buildMint({ ...base, amount1Desired: 0n })).toThrow();
    expect(() => buildMint({ ...base, slippageBps: 501 })).toThrow();
  });

  it("returns decoded simulated mint output and gas", async () => {
    const client = {
      simulateContract: async () => ({ result: [12n, 34n, 56n, 78n] }),
      estimateGas: async () => 250_000n,
    } as unknown as ApprovalSimulationClient;
    const mint = buildMint({
      pool: cirbtcPool,
      recipient: owner,
      tickLower: -10,
      tickUpper: 10,
      amount0Desired: 100n,
      amount1Desired: 200n,
      slippageBps: 0,
      deadline: 2_000_000_000n,
    });

    await expect(
      simulateMint({ client, owner, mint, blockNumber: 99n }),
    ).resolves.toEqual({
      blockNumber: "99",
      gasEstimate: "250000",
      tokenId: "12",
      liquidity: "34",
      amount0: "56",
      amount1: "78",
    });
  });

});

describe("v3 position check", () => {
  const meme = "0x2222222222222222222222222222222222222222" as const;
  const other = "0x3333333333333333333333333333333333333333" as const;
  const usdc = ARC_TOKENS.USDC.address;
  const positionClient = (token0: string, token1: string, fee: number, holder: string = owner) => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "ownerOf"
        ? holder
        : [0n, owner, token0, token1, fee, -50, 50, 999n, 0n, 0n, 0n, 0n],
  }) as unknown as ChainReadClient;
  const verify = (client: ChainReadClient) =>
    verifyV3Position({ client, owner, tokenId: 7n, blockNumber: 99n });

  it("accepts a wallet-owned position in any USDC pool, in either token order", async () => {
    const verified = { tokenId: "7", tickLower: -50, tickUpper: 50, liquidity: "999", blockNumber: "99" };

    await expect(verify(positionClient(ARC_TOKENS.cirBTC.address, usdc, 100)))
      .resolves.toEqual(verified);
    await expect(verify(positionClient(meme, usdc, 3_000))).resolves.toEqual(verified);
    await expect(verify(positionClient(usdc, meme, 10_000))).resolves.toEqual(verified);
  });

  it("rejects a pair without USDC, an unsupported fee tier and another owner", async () => {
    await expect(verify(positionClient(meme, other, 3_000)))
      .rejects.toThrow("Position is not in a USDC pool");
    await expect(verify(positionClient(meme, usdc, 250)))
      .rejects.toThrow("Position is not in a USDC pool");
    await expect(verify(positionClient(meme, usdc, 3_000, other)))
      .rejects.toThrow("Position is not owned by the managed wallet");
  });
});
