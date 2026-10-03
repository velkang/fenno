import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { FADE } from "../lib/motion";
import { formatUnits, zeroAddress } from "viem";
import { api, type PricedPool, type PublicPool } from "../lib/api-client";
import { ARC_TOKENS, tokenWaters, type Waters } from "@stillwater/chain";
import { IconSearch } from "../components/Icons";
import { usdcDecimals as poolUsdcDecimals } from "../lib/swap-actions";
import { Loading, Skeleton } from "../components/Skeleton";

export const PAGE_TITLE = "text-[clamp(2.2rem,4.5vw,3.5rem)] leading-[1.1] font-semibold tracking-[-.02em]";
export const PAGE_INTRO = "mt-2 max-w-[760px] text-[1.2rem] leading-relaxed text-ink-muted";
const OUTLINE_BUTTON = "min-h-11 rounded-full border border-line px-5 text-[1rem] font-medium text-ink hover:bg-tint";
const TABLE_GRID = "grid grid-cols-[minmax(240px,2.2fr)_minmax(120px,1fr)_minmax(120px,1fr)_minmax(90px,.8fr)_150px] items-center gap-4 px-8 py-5 max-[800px]:grid-cols-2 max-[800px]:gap-3 max-[800px]:px-5";
const STATE_TEXT = "px-6 py-16 text-center text-[1.1rem] text-ink-muted";
const CELL_LABEL = "hidden max-[800px]:mb-1 max-[800px]:block max-[800px]:text-[.8rem] max-[800px]:text-ink-faint";

export function poolSpotPrice(pool: PricedPool): number {
  const ratio = (Number(pool.sqrtPriceX96) / 2 ** 96) ** 2;
  const tokenIsZero = pool.token0.toLowerCase() === pool.token.address.toLowerCase();
  const usdcDecimals = poolUsdcDecimals(pool);
  const token1PerToken0 = ratio * 10 ** ((tokenIsZero ? pool.token.decimals : usdcDecimals) -
    (tokenIsZero ? usdcDecimals : pool.token.decimals));
  return tokenIsZero ? token1PerToken0 : 1 / token1PerToken0;
}

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

/**
 * A token price for display. Tiny prices use the zero-count notation DEX sites use:
 * 0.0₅4455 is 0.000004455 (five zeros after the decimal point). Huge ones are compact.
 */
export function formatPoolPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (value >= 0.0001) return value.toLocaleString("en-US", { maximumSignificantDigits: 5 });
  const [mantissa, exponent] = value.toExponential(3).split("e");
  const zeros = -Number(exponent) - 1;
  const digits = mantissa!.replace(".", "").replace(/0+$/, "");
  const count = [...String(zeros)].map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join("");
  return `0.0${count}${digits}`;
}

// 0x800000 marks a v4 pool whose fee changes trade by trade.
export function formatFeeTier(fee: number | undefined): string {
  if (fee === undefined) return "—";
  if (fee === 0x800000) return "Varying";
  return `${(fee / 10_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`;
}

const WATER_CHIPS: { id: Waters | ""; label: string }[] = [
  { id: "", label: "All waters" },
  { id: "still", label: "Still water" },
  { id: "gentle", label: "Gentle stream" },
  { id: "rapids", label: "Rapids" },
];

const TIER_TAG: Record<Waters, { label: string; tone: string }> = {
  still: { label: "Still water", tone: "border-feed-line text-feed" },
  gentle: { label: "Gentle stream", tone: "border-rest-line text-rest" },
  rapids: { label: "Rapids", tone: "border-danger-line text-danger" },
};

type Props = {
  waters: Waters | "";
  onWatersChange: (waters: Waters | "") => void;
  onSelectPool: (address: string) => void;
};

export function ExplorePage({ waters, onWatersChange, onSelectPool }: Props) {
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [pools, setPools] = useState<PublicPool[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledQuery(query.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => { setOffset(0); }, [waters]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    api.listPools(settledQuery, offset, waters).then((result) => {
      if (!current) return;
      setPools(result.pools);
      setNextOffset(result.nextOffset);
      setError(null);
    }).catch((reason: unknown) => {
      if (!current) return;
      setError(reason instanceof Error ? reason.message : "Could not load Arc pools.");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [settledQuery, offset, waters, retry]);

  return <section className="mx-auto flex w-full max-w-[1280px] flex-col gap-7 pt-2 text-ink" aria-labelledby="explore-title">
    <div className="flex flex-col gap-2.5">
      <h1 id="explore-title" className={PAGE_TITLE}>Explore pools</h1>
      <p className={PAGE_INTRO}>Every token paired with USDC on Arc, newest first. A pool created a minute ago is already here.</p>
    </div>
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex min-h-[60px] min-w-[min(100%,420px)] flex-1 items-center gap-3 rounded-full border border-line bg-card px-5 focus-within:border-band">
        <IconSearch size={20} className="text-ink-muted" />
        <span className="sr-only">Search pools</span>
        <input className="h-14 w-full flex-1 rounded-none border-0 bg-transparent p-0 text-[1.1rem] text-ink shadow-none focus:border-0 focus:shadow-none"
          value={query} onChange={(event) => { setLoading(true); setQuery(event.target.value); }}
          name="pool-search" type="search" spellCheck={false}
          placeholder="Search a token name, or paste a contract address…" autoComplete="off" />
        {query ? <button type="button" className="min-h-10 rounded-full px-3 text-[.95rem] text-ink-muted hover:text-ink"
          onClick={() => { setQuery(""); setLoading(true); }} aria-label="Clear search">Clear</button> : null}
      </label>
      <div role="group" aria-label="Waters" className="flex flex-wrap gap-2.5">
        {WATER_CHIPS.map((chip) => {
          const pressed = waters === chip.id;
          return <button key={chip.label} type="button" aria-pressed={pressed} onClick={() => onWatersChange(chip.id)}
            className={`relative min-h-12 rounded-full border px-5 text-[1.02rem] transition-colors ${pressed
              ? "border-accent font-semibold text-on-accent" : "border-line bg-tint font-medium text-ink hover:bg-card"}`}>
            {/* The filled pill glides to the chosen chip. */}
            {pressed ? <motion.span layoutId="waters-chip" aria-hidden="true" style={{ borderRadius: 999 }}
              className="absolute -inset-px bg-accent" /> : null}
            <span className="relative">{chip.label}</span>
          </button>;
        })}
      </div>
    </div>
    <div className="overflow-hidden rounded-[28px] border border-line bg-card" role="region" aria-label="Arc liquidity pools">
      <div className={`${TABLE_GRID} border-b border-line text-[.85rem] font-semibold tracking-[.06em] text-ink-muted uppercase max-[800px]:hidden`} aria-hidden="true">
        <span>Pool</span><span>Token price</span><span>USDC in pool</span><span>You earn</span><span />
      </div>
      {loading ? <PoolRowsSkeleton />
        : error ? <p className={`${STATE_TEXT} text-danger`} role="alert">{error} <button type="button" className="ml-2.5 text-link underline" onClick={() => { setError(null); setLoading(true); setRetry((value) => value + 1); }}>Try again</button></p>
          : pools.length === 0 ? <p className={STATE_TEXT}>{settledQuery
            ? "No pool found. Check the token address or try another name."
            : waters ? "No pools in these waters yet." : "No pools listed yet. Paste a token address to look it up directly."}</p>
            : pools.map((pool, index) => {
              const tier = TIER_TAG[tokenWaters(pool.token.address)];
              // New rows fade up once as a list arrives; the stagger stops after ten rows.
              return <motion.button type="button" key={pool.address}
                initial={{ opacity: 0, transform: "translateY(6px)" }} animate={{ opacity: 1, transform: "none" }}
                transition={{ ...FADE, delay: Math.min(index, 10) * 0.03 }}
                className={`${TABLE_GRID} min-h-[92px] w-full border-b border-line bg-transparent text-left text-[1.15rem] text-ink transition-colors last:border-b-0 hover:bg-tint/60`}
                onClick={() => onSelectPool(pool.address)} aria-label={`Add liquidity to the ${pool.token.symbol} / USDC pool`}>
                <span className="flex min-w-0 items-center gap-4 max-[800px]:col-span-full">
                  <span className="grid size-12 flex-none place-items-center rounded-full bg-sage text-[.9rem] font-semibold text-hand" aria-hidden="true">{pool.token.symbol.slice(0, 2).toUpperCase()}</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2.5">
                      <strong className="overflow-hidden font-semibold text-ellipsis whitespace-nowrap">{pool.token.symbol} / USDC</strong>
                      <span className={`rounded-full border px-2.5 py-0.5 text-[.78rem] font-semibold whitespace-nowrap ${tier.tone}`}>{tier.label}</span>
                    </span>
                    <small className="font-mono text-[.85rem] text-ink-muted">Token {pool.token.address.slice(0, 6)}…{pool.token.address.slice(-4)}
                      {pool.hooks && pool.hooks.toLowerCase() !== zeroAddress ? " · Has extra pool rules" : ""}</small>
                  </span>
                </span>
                <span className="tabular-nums"><small className={CELL_LABEL}>Token price</small>${formatPoolPrice(poolSpotPrice(pool))}</span>
                <span className="text-ink-muted tabular-nums"><small className={CELL_LABEL}>USDC in pool</small>{pool.usdcReserve === null ? "—" :
                  `$${Number(formatUnits(BigInt(pool.usdcReserve), ARC_TOKENS.USDC.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</span>
                <span className="tabular-nums"><small className={CELL_LABEL}>You earn per trade</small>{formatFeeTier(pool.fee)}</span>
                <span className="text-[1.02rem] font-semibold whitespace-nowrap text-link max-[800px]:justify-self-end">Add liquidity <span aria-hidden="true">→</span></span>
              </motion.button>;
            })}
    </div>
    {offset > 0 || nextOffset !== null ? <div className="flex items-center justify-center gap-5 text-[1rem] text-ink-muted">
      <button type="button" className={`${OUTLINE_BUTTON} disabled:cursor-not-allowed disabled:opacity-40`} disabled={offset === 0} onClick={() => { setLoading(true); setOffset(Math.max(0, offset - 25)); }}>Previous</button>
      <span>Page {Math.floor(offset / 25) + 1}</span>
      <button type="button" className={`${OUTLINE_BUTTON} disabled:cursor-not-allowed disabled:opacity-40`} disabled={nextOffset === null} onClick={() => { setLoading(true); setOffset(nextOffset ?? offset); }}>Next</button>
    </div> : null}
    <p className="text-[.95rem] leading-relaxed text-ink-muted">Stillwater lists any pool it can work with. That doesn’t mean the token has been reviewed or is safe, so only add tokens you trust.</p>
  </section>;
}

function PoolRowsSkeleton() {
  return <Loading label="Loading pools…">
    {Array.from({ length: 6 }, (_, row) => <div key={row} className={`${TABLE_GRID} min-h-[92px] border-b border-line last:border-b-0`}>
      <span className="flex items-center gap-4 max-[800px]:col-span-full">
        <Skeleton className="size-12 flex-none" />
        <span className="flex flex-col gap-2"><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-28" /></span>
      </span>
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-14" />
      <Skeleton className="h-4 w-24 max-[800px]:justify-self-end" />
    </div>)}
  </Loading>;
}
