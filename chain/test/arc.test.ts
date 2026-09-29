import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  ALPHA_POOL,
  ARC_CHAIN_ID,
  ARC_TOKENS,
  UNISWAP_SHARED_ARC,
  UNISWAP_V3_ARC,
  arc,
  canSpendArcUsdc,
  maxArcUsdcAmount,
} from "../src";

describe("Arc alpha configuration", () => {
  it("uses Arc mainnet chain ID and USDC gas metadata", () => {
    expect(arc.id).toBe(ARC_CHAIN_ID);
    expect(arc.nativeCurrency).toEqual({
      name: "USDC",
      symbol: "USDC",
      decimals: 18,
    });
    expect(ARC_TOKENS.USDC.decimals).toBe(6);
  });

  it("pins the selected cirBTC/USDC 0.01% v3 pool", () => {
    expect(ALPHA_POOL.protocol).toBe("uniswap-v3");
    expect(ALPHA_POOL.fee).toBe(100);
    expect(ALPHA_POOL.tickSpacing).toBe(1);
    expect(ALPHA_POOL.token0.address).toBe(ARC_TOKENS.cirBTC.address);
    expect(ALPHA_POOL.token1.address).toBe(ARC_TOKENS.USDC.address);
  });

  it("contains only valid distinct allowlist addresses", () => {
    const addresses = [
      UNISWAP_V3_ARC.factory.address,
      UNISWAP_V3_ARC.nonfungiblePositionManager.address,
      UNISWAP_SHARED_ARC.universalRouter.address,
      UNISWAP_SHARED_ARC.permit2.address,
      ALPHA_POOL.address,
      ARC_TOKENS.USDC.address,
      ARC_TOKENS.cirBTC.address,
    ];

    expect(addresses.map((address) => getAddress(address))).toEqual(addresses);
    expect(new Set(addresses.map((address) => address.toLowerCase())).size).toBe(
      addresses.length,
    );
  });

  it("pins the current Arc Universal Router bytecode", () => {
    expect(UNISWAP_SHARED_ARC.universalRouter).toEqual({
      address: getAddress("0x8702463e73f74d0b6765aBceb314Ef07aCb92650"),
      codeSize: 24_380,
      bytecodeHash: "0x2e80a35dc8a1da121611acc5c31be03c2e63669135461e63947901ecf8a1654d",
    });
  });

  it("uses one USDC balance across the 18-decimal gas and 6-decimal transfer interfaces", () => {
    const balance = 6_000_000_000_000_000_000n;
    const reserve = 20_000_000_000_000_000n;
    expect(maxArcUsdcAmount(balance, reserve)).toBe(5_980_000n);
    expect(canSpendArcUsdc(balance, 5_980_000n, reserve)).toBe(true);
    expect(canSpendArcUsdc(balance, 5_980_001n, reserve)).toBe(false);
    expect(maxArcUsdcAmount(1n, reserve)).toBe(0n);
  });
});
