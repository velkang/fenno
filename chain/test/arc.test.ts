import { createPublicClient, getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  UNISWAP_SHARED_ARC,
  UNISWAP_V3_ARC,
  arc,
  arcRpcTransport,
  canSpendArcUsdc,
  maxArcUsdcAmount,
} from "../src";

describe("Arc configuration", () => {
  it("uses Arc mainnet chain ID and USDC gas metadata", () => {
    expect(arc.id).toBe(ARC_CHAIN_ID);
    expect(arc.nativeCurrency).toEqual({
      name: "USDC",
      symbol: "USDC",
      decimals: 18,
    });
    expect(ARC_TOKENS.USDC.decimals).toBe(6);
  });

  it("contains only valid distinct allowlist addresses", () => {
    const addresses = [
      UNISWAP_V3_ARC.factory.address,
      UNISWAP_V3_ARC.nonfungiblePositionManager.address,
      UNISWAP_SHARED_ARC.universalRouter.address,
      UNISWAP_SHARED_ARC.permit2.address,
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

describe("arcRpcTransport", () => {
  it("keeps concurrent clients for the same URL in separate batches", async () => {
    // Workers cancels a request whose RPC result resolves inside another request's batch.
    const bodies: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const calls = JSON.parse(body) as { id: number }[];
      return new Response(JSON.stringify(calls.map(({ id }) => ({ jsonrpc: "2.0", id, result: "0x1" }))),
        { headers: { "content-type": "application/json" } });
    });
    try {
      const first = createPublicClient({ chain: arc, transport: arcRpcTransport("https://rpc.example") });
      const second = createPublicClient({ chain: arc, transport: arcRpcTransport("https://rpc.example") });
      await Promise.all([first.getBlockNumber({ cacheTime: 0 }), second.getBlockNumber({ cacheTime: 0 })]);
      expect(bodies).toHaveLength(2);
      expect(bodies.every((body) => JSON.parse(body).length === 1)).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
