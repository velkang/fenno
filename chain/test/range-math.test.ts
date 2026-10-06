import { zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_TOKENS, BANDS, bandTicks, poolDepthUsd, positionAmounts, priceImpactBps, rebalanceSwap, tickToPrice, usdcValue } from "../src";

const token = "0x2222222222222222222222222222222222222222" as const;
const Q96 = 2n ** 96n;
// sqrtPriceX96 for a raw price (currency1 per currency0).
const sqrtPrice = (price: number) => BigInt(Math.round(Math.sqrt(price) * 2 ** 96)).toString();

describe("band ticks", () => {
  it("brackets the token's dollar price by the band, on the pool's tick spacing", () => {
    // Token (18 decimals) is currency0, USDC (6) currency1, token at $2.
    const { tickLower, tickUpper } = bandTicks({ spotPrice: 2, spread: BANDS.balanced,
      tokenDecimals: 18, usdcDecimals: 6, usdcIsPoolToken0: false, tickSpacing: 60 });
    expect(Math.abs(tickLower % 60)).toBe(0);
    expect(Math.abs(tickUpper % 60)).toBe(0);
    expect(tickToPrice(tickLower, 18, 6)).toBeCloseTo(1.8, 1);
    expect(tickToPrice(tickUpper, 18, 6)).toBeCloseTo(2.2, 1);
  });

  it("inverts the band when USDC is currency0", () => {
    const { tickLower, tickUpper } = bandTicks({ spotPrice: 2, spread: BANDS.wide,
      tokenDecimals: 18, usdcDecimals: 18, usdcIsPoolToken0: true, tickSpacing: 200 });
    expect(tickLower).toBeLessThan(tickUpper);
    // Pool price is tokens per USDC; the token's dollar price is its inverse.
    expect(1 / tickToPrice(tickUpper, 18, 18)).toBeCloseTo(1.5, 1);
    expect(1 / tickToPrice(tickLower, 18, 18)).toBeCloseTo(2.5, 1);
  });

  it("keeps a band at least one tick spacing wide", () => {
    const { tickLower, tickUpper } = bandTicks({ spotPrice: 1, spread: 0.0001,
      tokenDecimals: 6, usdcDecimals: 6, usdcIsPoolToken0: false, tickSpacing: 200 });
    expect(tickUpper - tickLower).toBeGreaterThanOrEqual(200);
  });
});

describe("swap to re-centre", () => {
  // Token is currency0 at 1 raw USDC per raw token, band ±10% in ticks.
  const range = { sqrtPriceX96: Q96.toString(), tickLower: -1_000, tickUpper: 1_000, tokenIsZero: true };
  const ratioAfter = (token: bigint, usdc: bigint) => {
    const per = positionAmounts(1e18, range.sqrtPriceX96, range.tickLower, range.tickUpper);
    return { wanted: per.amount1 / per.amount0, got: Number(usdc) / Number(token) };
  };

  it("turns part of the USDC into the token when the band needs both", () => {
    const swap = rebalanceSwap({ ...range, token: 0n, usdc: 1_000_000n });
    expect(swap?.from).toBe("usdc");
    const after = ratioAfter(swap!.amountIn, 1_000_000n - swap!.amountIn);
    expect(after.got).toBeCloseTo(after.wanted, 2);
  });

  it("turns part of the token into USDC when holding only the token", () => {
    const swap = rebalanceSwap({ ...range, token: 1_000_000n, usdc: 0n });
    expect(swap?.from).toBe("token");
    const after = ratioAfter(1_000_000n - swap!.amountIn, swap!.amountIn);
    expect(after.got).toBeCloseTo(after.wanted, 2);
  });

  it("works when USDC is currency0", () => {
    // Token is currency1; 4 raw tokens per raw USDC.
    const swap = rebalanceSwap({ sqrtPriceX96: sqrtPrice(4), tickLower: 13_000, tickUpper: 14_800,
      tokenIsZero: false, token: 0n, usdc: 1_000_000n });
    expect(swap?.from).toBe("usdc");
    expect(swap!.amountIn).toBeGreaterThan(0n);
    expect(swap!.amountIn).toBeLessThan(1_000_000n);
  });

  it("skips a swap too small to matter", () => {
    const per = positionAmounts(1e6, range.sqrtPriceX96, range.tickLower, range.tickUpper);
    expect(rebalanceSwap({ ...range, token: BigInt(Math.round(per.amount0)), usdc: BigInt(Math.round(per.amount1)) }))
      .toBeNull();
    expect(rebalanceSwap({ ...range, token: 0n, usdc: 0n })).toBeNull();
  });
});

describe("value of a v4 deposit in USDC", () => {
  it("prices the token side with USDC as currency1", () => {
    // Price 4 raw USDC per raw token: sqrtPrice = 2 * Q96.
    const pool = { currency0: token, currency1: ARC_TOKENS.USDC.address, sqrtPriceX96: (2n * Q96).toString() };
    expect(usdcValue({ pool, amount0: 10n, amount1: 5n })).toEqual({ usdc: 45n, usdcDecimals: 6 });
  });

  it("prices the token side with native USDC as currency0", () => {
    // 4 raw tokens per raw USDC, so 40 raw tokens are worth 10 raw USDC.
    const pool = { currency0: zeroAddress, currency1: token, sqrtPriceX96: (2n * Q96).toString() };
    expect(usdcValue({ pool, amount0: 5n, amount1: 40n })).toEqual({ usdc: 15n, usdcDecimals: 18 });
  });

  it("has no value for a pool without USDC or without a price", () => {
    const other = "0x3333333333333333333333333333333333333333" as const;
    expect(usdcValue({ pool: { currency0: token, currency1: other, sqrtPriceX96: Q96.toString() },
      amount0: 1n, amount1: 1n })).toBeNull();
    expect(usdcValue({ pool: { currency0: zeroAddress, currency1: token, sqrtPriceX96: "0" },
      amount0: 1n, amount1: 1n })).toBeNull();
  });
});

describe("price impact of a swap", () => {
  it("is nothing when the swap fills at the pool's price after its fee", () => {
    expect(priceImpactBps({ sqrtPriceX96: Q96.toString(), zeroForOne: true, amountIn: 1_000_000n,
      amountOut: 997_000n, feePips: 3_000 })).toBe(0);
    expect(priceImpactBps({ sqrtPriceX96: Q96.toString(), zeroForOne: false, amountIn: 1_000_000n,
      amountOut: 900_000n, feePips: 3_000 })).toBe(973);
  });

  it("is nearly everything when an almost empty pool is asked for a dollar", () => {
    // cirBTC at $85,600 is 856 raw USDC per raw cirBTC; 1.1 USDC bought 10 sats instead of about 1,267.
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(856) * 2 ** 96)).toString();
    expect(priceImpactBps({ sqrtPriceX96, zeroForOne: false, amountIn: 1_100_000n, amountOut: 10n, feePips: 13_800 }))
      .toBeGreaterThan(9_900);
  });
});

describe("depth of a pool near its price", () => {
  it("is the USDC that moves the price 2%, whichever side USDC is on", () => {
    expect(poolDepthUsd({ currency0: token, currency1: ARC_TOKENS.USDC.address, sqrtPriceX96: Q96.toString(),
      liquidity: (10n ** 12n).toString() })).toBeCloseTo(9_950.4, 0);
    expect(poolDepthUsd({ currency0: zeroAddress, currency1: token, sqrtPriceX96: Q96.toString(),
      liquidity: (10n ** 24n).toString() })).toBeCloseTo(9_950.4, 0);
  });

  it("is next to nothing for an almost empty pool, and zero without USDC or a price", () => {
    expect(poolDepthUsd({ currency0: token, currency1: ARC_TOKENS.USDC.address, sqrtPriceX96: Q96.toString(),
      liquidity: "352" })).toBeLessThan(0.01);
    expect(poolDepthUsd({ currency0: token, currency1: "0x3333333333333333333333333333333333333333",
      sqrtPriceX96: Q96.toString(), liquidity: "1000000" })).toBe(0);
    expect(poolDepthUsd({ currency0: zeroAddress, currency1: token, sqrtPriceX96: "0", liquidity: "1000000" })).toBe(0);
  });
});
