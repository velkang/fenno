import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { zeroAddress } from "viem";
import { BANDS, bandTicks } from "@stillwater/chain";
import { api, ApiError, type AutomationRun, type PricedPool, type RecentreBand } from "../../lib/api-client";
import { runFailureMessage } from "../../lib/automation";
import { fade, lift } from "../../lib/motion";
import { formatPoolPrice, poolSpotPrice } from "../../pages/ExplorePage";
import { STRATEGIES, type StrategyKey } from "../StrategyCards";

const BAND_OF: Record<StrategyKey, RecentreBand> = { conservative: "wide", balanced: "balanced", focused: "narrow" };

/** A v4 or v3 position, enough to work out its new band. */
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

/** The new band around today's price. */
function useNewBand(position: RecentrePosition, band: RecentreBand) {
  return useMemo(() => {
    const { pool } = position;
    const tokenIsZero = pool.token0.toLowerCase() === pool.token.address.toLowerCase();
    const usdcDecimals = [pool.token0, pool.token1].some((address) => address.toLowerCase() === zeroAddress) ? 18 : 6;
    return bandTicks({ spotPrice: poolSpotPrice(pool), spread: BANDS[band], tokenDecimals: pool.token.decimals,
      usdcDecimals, usdcIsPoolToken0: !tokenIsZero, tickSpacing: pool.tickSpacing });
  }, [position, band]);
}

export function RecentreDialog({ position, resting, onClose, onStarted, onError }: Props) {
  const [strategy, setStrategy] = useState<StrategyKey>("balanced");
  const [starting, setStarting] = useState(false);
  const band = BAND_OF[strategy];
  const plan = useNewBand(position, band);
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
            {resting ? "Move your band around today's price so it earns again." : "Move your band around today's price."}
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

        <p className="text-[1.05rem]">
          New band: <strong className="font-semibold tabular-nums">${formatPoolPrice(plan.minPrice)} – ${formatPoolPrice(plan.maxPrice)}</strong>
        </p>

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
