import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { formatUnits, zeroAddress } from "viem";
import { BANDS, bandTicks, positionAmounts, rebalanceSwap } from "@stillwater/chain";
import { api, ApiError, type AutomationRun, type PricedPool, type RecentreBand } from "../../lib/api-client";
import { runFailureMessage } from "../../lib/automation";
import { fade, lift } from "../../lib/motion";
import { formatPoolPrice, poolSpotPrice } from "../../pages/ExplorePage";
import { STRATEGIES, type StrategyKey } from "../StrategyCards";

const BAND_OF: Record<StrategyKey, RecentreBand> = { conservative: "wide", balanced: "balanced", focused: "narrow" };

/** A v4 or v3 position: what the preview needs to work out the new band. */
type RecentrePosition = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  pool: PricedPool & { address: string; tickSpacing: number };
};

type Props = {
  position: RecentrePosition;
  resting: boolean;
  onClose: () => void;
  onStarted: (run: AutomationRun) => void;
  onError: (message: string) => void;
};

const amount = (raw: bigint, decimals: number) =>
  Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumSignificantDigits: 6 });

/** What re-centring will do, in plain steps, before anything is sent. */
function usePlan(position: RecentrePosition, band: RecentreBand) {
  return useMemo(() => {
    const { pool } = position;
    const tokenIsZero = pool.token0.toLowerCase() === pool.token.address.toLowerCase();
    const usdcDecimals = [pool.token0, pool.token1].some((address) => address.toLowerCase() === zeroAddress) ? 18 : 6;
    const { minPrice, maxPrice, tickLower, tickUpper } = bandTicks({ spotPrice: poolSpotPrice(pool),
      spread: BANDS[band], tokenDecimals: pool.token.decimals, usdcDecimals, usdcIsPoolToken0: !tokenIsZero,
      tickSpacing: pool.tickSpacing });
    const held = positionAmounts(Number(position.liquidity), pool.sqrtPriceX96, position.tickLower, position.tickUpper);
    const [token, usdc] = tokenIsZero ? [held.amount0, held.amount1] : [held.amount1, held.amount0];
    const swap = rebalanceSwap({ sqrtPriceX96: pool.sqrtPriceX96, tickLower, tickUpper, tokenIsZero,
      token: BigInt(Math.floor(token)), usdc: BigInt(Math.floor(usdc)) });
    const swapText = !swap ? null : swap.from === "usdc"
      ? `${amount(swap.amountIn, usdcDecimals)} USDC into ${pool.token.symbol}`
      : `${amount(swap.amountIn, pool.token.decimals)} ${pool.token.symbol} into USDC`;
    return { minPrice, maxPrice, swapText, transactions: swap ? 3 : 2 };
  }, [position, band]);
}

export function RecentreDialog({ position, resting, onClose, onStarted, onError }: Props) {
  const [strategy, setStrategy] = useState<StrategyKey>("balanced");
  const [starting, setStarting] = useState(false);
  const band = BAND_OF[strategy];
  const plan = usePlan(position, band);
  const symbol = position.pool.token.symbol;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !starting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, starting]);

  const start = async () => {
    setStarting(true);
    try {
      const { run } = await api.startRecentre(position.tokenId, band, position.pool.address);
      onStarted(run);
    } catch (error) {
      onError(error instanceof ApiError ? runFailureMessage(error.code) : "Couldn't start. Try again.");
      setStarting(false);
    }
  };

  return (
    <motion.div {...fade} className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !starting) onClose(); }}>
      <motion.div {...lift} role="dialog" aria-modal="true" aria-labelledby="recentre-title"
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col gap-6 overflow-y-auto overscroll-contain rounded-[28px] border border-line bg-card p-8 text-ink shadow-2xl">
        <div className="flex flex-col gap-2">
          <h2 id="recentre-title" className="text-[1.7rem] font-semibold">Re-centre your {symbol} band</h2>
          <p className="text-[1.05rem] leading-relaxed text-ink-muted">
            {resting
              ? "Your pond is resting because the price left its band. Re-centring moves the band around today's price so it earns again."
              : "Re-centring moves your band around today's price."}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-[1rem] font-semibold">New band</legend>
          <div className="grid grid-cols-3 gap-2.5 max-[520px]:grid-cols-1">
            {STRATEGIES.map((option) => (
              <label key={option.key}
                className={`flex cursor-pointer flex-col gap-0.5 rounded-[18px] border px-4 py-3 ${strategy === option.key
                  ? "border-accent bg-feed-soft" : "border-line bg-field hover:bg-tint"}`}>
                <input type="radio" name="recentre-band" value={option.key} checked={strategy === option.key}
                  onChange={() => setStrategy(option.key)} className="sr-only" />
                <span className="font-semibold">{option.name}</span>
                <span className="text-[.9rem] text-ink-muted">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <span className="text-[1rem] font-semibold">What happens</span>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[1rem] leading-relaxed">
            <li>Close this band. Its {symbol}, USDC and fees come back to your Stillwater wallet.</li>
            {plan.swapText ? <li>Swap about {plan.swapText}, so both sides fit the new band.</li> : null}
            <li>Open a new band from ${formatPoolPrice(plan.minPrice)} to ${formatPoolPrice(plan.maxPrice)}.</li>
          </ol>
          <p className="text-[.9rem] leading-relaxed text-ink-muted">
            {plan.transactions} transactions, plus approvals the first time, each with a small network fee. Only the
            money from this band is used. If a step fails, the rest stop and your tokens stay in your Stillwater wallet.
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} disabled={starting}
            className="min-h-12 whitespace-nowrap rounded-full border border-line px-6 font-medium hover:bg-tint disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void start()} disabled={starting}
            className="min-h-12 whitespace-nowrap rounded-full bg-accent px-7 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
            {starting ? "Starting…" : "Re-centre"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
