import { getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_TOKENS,
  UNISWAP_V3_ARC,
  discoverArcTokenPools,
  type PoolDiscoveryClient,
} from "../src";

const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const pool = getAddress("0x3333333333333333333333333333333333333333");

function client(overrides: { initialized?: boolean; usdcFirst?: boolean } = {}): PoolDiscoveryClient {
  return {
    async getCode({ address }) {
      return address === UNISWAP_V3_ARC.factory.address || address === token || address === pool
        ? "0x6000" : "0x";
    },
    async getBalance() { return 0n; },
    async simulateContract() { return { result: true }; },
    async readContract({ address, functionName, args = [] }) {
      if (address === token) {
        if (functionName === "decimals") return 18;
        if (functionName === "symbol") return "MEME";
        if (functionName === "balanceOf") return 12n;
        if (functionName === "allowance") return 3n;
      }
      if (address === ARC_TOKENS.USDC.address) {
        if (functionName === "decimals") return 6;
        if (functionName === "symbol") return "USDC";
        if (functionName === "balanceOf") return 4n;
        if (functionName === "allowance") return 5n;
      }
      if (address === UNISWAP_V3_ARC.factory.address && functionName === "getPool") {
        return (args[2] as number) === 500 ? pool : zeroAddress;
      }
      if (address === pool) {
        if (functionName === "slot0") return [overrides.initialized === false ? 0n : 1n, 0, 0, 0, 0, 0, true];
        if (functionName === "liquidity") return 99n;
        if (functionName === "token0") return overrides.usdcFirst ? ARC_TOKENS.USDC.address : token;
        if (functionName === "token1") return overrides.usdcFirst ? token : ARC_TOKENS.USDC.address;
        if (functionName === "fee") return 500;
        if (functionName === "tickSpacing") return 10;
      }
      throw new Error(`Unexpected call ${functionName} ${address}`);
    },
  };
}

describe("Arc token pool discovery", () => {
  it("returns only initialized canonical token/USDC pools and wallet context", async () => {
    const result = await discoverArcTokenPools({
      client: client(),
      tokenAddress: token,
      owner,
    });
    expect(result.token).toMatchObject({ address: token, symbol: "MEME", decimals: 18, balance: "12", allowance: "3" });
    expect(result.usdc).toMatchObject({ address: ARC_TOKENS.USDC.address, balance: "4", allowance: "5" });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({ address: pool, fee: 500, tickSpacing: 10, liquidity: "99" });
  });

  it("does not treat an uninitialized pool as usable", async () => {
    const result = await discoverArcTokenPools({ client: client({ initialized: false }), tokenAddress: token });
    expect(result.pools).toEqual([]);
  });

  it("accepts a selected pool when USDC is token0", async () => {
    const result = await discoverArcTokenPools({ client: client({ usdcFirst: true }), tokenAddress: token });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].token0.address).toBe(ARC_TOKENS.USDC.address);
    expect(result.pools[0].token1.address).toBe(token);
  });
});
