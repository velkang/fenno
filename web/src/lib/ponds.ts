import { zeroAddress } from "viem";
import type { AlphaWalletSummary, V3Position } from "@stillwater/chain";
import type { PricedPool, V4Position } from "./api-client";
import { tickToPrice } from "./range-math";
import { poolSpotPrice } from "../pages/ExplorePage";

// A "pond" is one liquidity position, v3 or v4, described the way the Pond page
// talks about it: is the koi (today's price) inside its band, and what is it worth.

export type PondState = "feeding" | "resting-below" | "resting-above";

export type Pond = {
  key: string;
  tokenId: string;
  symbol: string;
  pair: string;
  state: PondState;
  /** In range but within the outer tenth of the band. */
  nearEdge: boolean;
  price: number;
  min: number;
  max: number;
  valueUsd: number | null;
  gatheredUsd: number | null;
  v4?: V4Position;
  v3?: V3Position;
};

/** Raw token amounts a position holds at the current price (Uniswap's liquidity math). */
export function positionAmounts(liquidity: number, sqrtPriceX96: string, tickLower: number, tickUpper: number) {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower = Math.pow(1.0001, tickLower / 2);
  const sqrtUpper = Math.pow(1.0001, tickUpper / 2);
  if (sqrtPrice <= sqrtLower) return { amount0: liquidity * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper), amount1: 0 };
  if (sqrtPrice >= sqrtUpper) return { amount0: 0, amount1: liquidity * (sqrtUpper - sqrtLower) };
  return { amount0: liquidity * (sqrtUpper - sqrtPrice) / (sqrtPrice * sqrtUpper), amount1: liquidity * (sqrtPrice - sqrtLower) };
}

function describe(price: number, min: number, max: number): Pick<Pond, "state" | "nearEdge"> {
  if (price < min) return { state: "resting-below", nearEdge: false };
  if (price > max) return { state: "resting-above", nearEdge: false };
  const position = max > min ? (price - min) / (max - min) : 0.5;
  return { state: "feeding", nearEdge: position < 0.1 || position > 0.9 };
}

/** How a position is doing, from its pool's price. The same for v3 and v4. */
function measure(position: {
  pool: PricedPool;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  fees: { amount0: string; amount1: string } | null;
}): Pick<Pond, "symbol" | "pair" | "state" | "nearEdge" | "price" | "min" | "max" | "valueUsd" | "gatheredUsd"> {
  const { pool } = position;
  const usdcDecimals = [pool.token0, pool.token1].some((address) => address.toLowerCase() === zeroAddress) ? 18 : 6;
  const tokenIsZero = pool.token0.toLowerCase() === pool.token.address.toLowerCase();
  const price = poolSpotPrice(pool);
  // The band in dollars per token, whichever side of the pool USDC is on.
  const [min, max] = tokenIsZero
    ? [tickToPrice(position.tickLower, pool.token.decimals, usdcDecimals), tickToPrice(position.tickUpper, pool.token.decimals, usdcDecimals)]
    : [1 / tickToPrice(position.tickUpper, usdcDecimals, pool.token.decimals), 1 / tickToPrice(position.tickLower, usdcDecimals, pool.token.decimals)];
  const amounts = positionAmounts(Number(position.liquidity), pool.sqrtPriceX96, position.tickLower, position.tickUpper);
  const [tokenRaw, usdcRaw] = tokenIsZero ? [amounts.amount0, amounts.amount1] : [amounts.amount1, amounts.amount0];
  const toUsd = (tokenAmount: number, usdcAmount: number) =>
    tokenAmount / 10 ** pool.token.decimals * price + usdcAmount / 10 ** usdcDecimals;
  const fees = position.fees;
  const gatheredUsd = fees && Number.isFinite(price) ? toUsd(
    Number(tokenIsZero ? fees.amount0 : fees.amount1), Number(tokenIsZero ? fees.amount1 : fees.amount0)) : null;
  return {
    symbol: pool.token.symbol, pair: `${pool.token.symbol} / USDC`, ...describe(price, min, max), price, min, max,
    valueUsd: Number.isFinite(price) ? toUsd(tokenRaw, usdcRaw) : null, gatheredUsd,
  };
}

export function pondFromV4(position: V4Position): Pond {
  return { key: `v4:${position.tokenId}`, tokenId: position.tokenId, ...measure(position), v4: position };
}

/** The wallet's v3 positions, from the wallet summary. */
export function pondsFromSummary(summary: AlphaWalletSummary | null): Pond[] {
  return (summary?.positions ?? []).map((position) => ({
    key: `v3:${position.tokenId}`, tokenId: position.tokenId,
    ...measure({ ...position, fees: { amount0: position.claimable0.raw, amount1: position.claimable1.raw } }),
    v3: position,
  }));
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const count = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** The page's two-line headline, from how the ponds are doing. */
export function pondHeadline(ponds: Pond[]): [string, string] {
  if (ponds.length === 0) return ["The pond is quiet.", "No koi yet."];
  const feeding = ponds.filter((pond) => pond.state === "feeding").length;
  const resting = ponds.length - feeding;
  if (resting === 0) {
    return ["The water is calm today.", ponds.length === 1 ? "Your koi is feeding." : `${count(feeding)} of your koi are feeding.`];
  }
  if (feeding === 0) {
    return ["The water has moved today.", ponds.length === 1 ? "Your pond is resting." : `All ${count(resting).toLowerCase()} of your ponds are resting.`];
  }
  return [feeding >= resting ? "The water is calm today." : "The water has moved today.",
    `${count(feeding)} feeding, ${count(resting).toLowerCase()} resting.`];
}

export type TomoNote = {
  id: string;
  message: string;
  advice: string;
  /** Plain steps behind "Walk me through it". */
  steps: string[];
  pond?: Pond;
};

/** Tomo's notes, most useful first. A note can be snoozed for a day. */
export function tomoNotes(ponds: Pond[], gatheredUsd: number): TomoNote[] {
  const notes: TomoNote[] = [];
  for (const pond of ponds) {
    if (pond.state === "resting-below") {
      notes.push({ id: `${pond.key}:below`, pond,
        message: `Your ${pond.symbol} pond is resting. The price drifted below your band, so it now holds only ${pond.symbol} and isn't earning.`,
        advice: "There's no rush. Many people wait a few days to see if the price drifts back before moving their band.",
        steps: [
          `Wait: if ${pond.symbol} rises back into your band, the pond starts earning again by itself.`,
          `Or close the pond. You get your ${pond.symbol} and any fees back in your Stillwater wallet.`,
          "Then open the pool again and choose a band around today's price.",
        ] });
    } else if (pond.state === "resting-above") {
      notes.push({ id: `${pond.key}:above`, pond,
        message: `Your ${pond.symbol} pond is resting. The price rose above your band, so it now holds only USDC and isn't earning.`,
        advice: "Your pond sold its token on the way up. You can wait for the price to return, or start a new band higher up.",
        steps: [
          `Wait: if ${pond.symbol} falls back into your band, the pond starts earning again by itself.`,
          "Or close the pond. You get your USDC and any fees back in your Stillwater wallet.",
          "Then open the pool again and choose a band around today's price.",
        ] });
    } else if (pond.nearEdge) {
      notes.push({ id: `${pond.key}:edge`, pond,
        message: `Your ${pond.symbol} koi is swimming near the edge of its band. It is still earning.`,
        advice: "If the price keeps moving that way, the pond will rest. Nothing to do yet; it's just worth knowing.",
        steps: [
          "A band only earns while the price is inside it.",
          "Wider bands rest less often but earn a little less per trade.",
          "You can close the pond and open a wider one at any time.",
        ] });
    }
  }
  if (gatheredUsd >= 1) {
    notes.push({ id: "gathered", message: `Your ponds have gathered ${formatUsd(gatheredUsd)} in fees.`,
      advice: "Collecting moves the fees to your Stillwater wallet. Your ponds keep earning either way.",
      steps: ["Open Positions and press Collect.", "Each pond with fees is collected in turn.", "The fees land in your Stillwater wallet."] });
  }
  if (ponds.length > 0 && notes.length === 0) {
    notes.push({ id: "calm", message: "All your koi are feeding. Nothing needs you today.",
      advice: "Your ponds earn a share of every trade while the price stays in their bands.", steps: [] });
  }
  if (ponds.length === 0) {
    notes.push({ id: "hello", message: "Hello. I'll keep an eye on your ponds and tell you, in plain words, when one needs you.",
      advice: "New here? Start in still water. It moves slowly, so you can learn how a band behaves.", steps: [] });
  }
  return notes;
}

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2, minimumFractionDigits: value >= 1000 ? 0 : 2 });
}
