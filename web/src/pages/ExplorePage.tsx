import { useEffect, useState } from "react";
import { formatUnits, zeroAddress } from "viem";
import { api, type PublicPool } from "../lib/api-client";
import { ARC_TOKENS } from "@stillwater/chain";
import { usdcDecimals as poolUsdcDecimals } from "../lib/swap-actions";

export const PAGE_TITLE = "text-[2rem] leading-[1.2] font-bold tracking-[-.03em]";
export const PAGE_INTRO = "mt-2 text-[.94rem] text-[#b6c1d1]";
const OUTLINE_BUTTON = "rounded-lg border border-[#344256] px-[11px] py-[7px] text-[#a8dac9]";
const TABLE_GRID = "grid grid-cols-[minmax(220px,2.2fr)_minmax(120px,1fr)_minmax(120px,1fr)_85px_110px] items-center gap-4 px-5 py-4 max-[800px]:grid-cols-2 max-[800px]:gap-3 max-[800px]:p-[18px]";
const STATE_TEXT = "px-6 py-14 text-center text-[#b6c1d1]";
const CELL_LABEL = "hidden max-[800px]:mb-1 max-[800px]:block max-[800px]:text-[.72rem] max-[800px]:text-[#8fa0b5]";

export function poolSpotPrice(pool: PublicPool): number {
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

type Props = { onSelectPool: (address: string) => void };

export function ExplorePage({ onSelectPool }: Props) {
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

  useEffect(() => {
    let current = true;
    api.listPools(settledQuery, offset).then((result) => {
      if (!current) return;
      setPools(result.pools);
      setNextOffset(result.nextOffset);
      setError(null);
    }).catch((reason: unknown) => {
      if (!current) return;
      setError(reason instanceof Error ? reason.message : "Could not load Arc pools.");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [settledQuery, offset, retry]);

  return <section className="m-auto max-w-[1500px] text-[#f3f4f6]" aria-labelledby="explore-title">
    <div className="mt-2 mb-7 flex items-end justify-between gap-6 max-[520px]:block">
      <div>
        <h1 id="explore-title" className={PAGE_TITLE}>Explore pools</h1>
        <p className={PAGE_INTRO}>Each pool pairs a token with USDC. Add both to a pool and earn a share of the fees traders pay.</p>
      </div>
      <span className="text-[.8rem] whitespace-nowrap text-[#b6c1d1] max-[520px]:mt-3.5 max-[520px]:block">Arc Mainnet</span>
    </div>
    <label className="mb-6 flex items-center gap-3 rounded-xl border border-[#344256] bg-[#151e2b] px-4 focus-within:border-[#10b981]">
      <span className="sr-only">Search pools</span>
      <input className="h-14 w-full flex-1 rounded-none border-0 bg-transparent p-0 text-base text-[#f3f4f6] shadow-none placeholder:text-[#9cabc0] focus:border-0 focus:shadow-none"
        value={query} onChange={(event) => { setLoading(true); setQuery(event.target.value); }}
        placeholder="Search by token name or paste its address" autoComplete="off" />
      {query ? <button type="button" className={OUTLINE_BUTTON} onClick={() => { setQuery(""); setLoading(true); }}
        aria-label="Clear search">Clear</button> : null}
    </label>
    <div className="overflow-hidden rounded-[14px] border border-[#29364a] bg-[#111827]" role="region" aria-label="Arc liquidity pools">
      <div className={`${TABLE_GRID} border-b border-[#29364a] text-[.75rem] font-[650] tracking-[.03em] text-[#92a1b5] uppercase max-[800px]:hidden`} aria-hidden="true">
        <span>Pool</span><span>Token price</span><span>USDC in pool</span><span>You earn per trade</span><span />
      </div>
      {loading ? <p className={STATE_TEXT} role="status">Loading pools…</p>
        : error ? <p className={`${STATE_TEXT} text-[#fda4af]`} role="alert">{error} <button className="ml-2.5 text-[#6ee7b7] underline" onClick={() => { setError(null); setLoading(true); setRetry((value) => value + 1); }}>Try again</button></p>
          : pools.length === 0 ? <p className={STATE_TEXT}>{settledQuery
            ? "No pool found. Check the token address or try another name."
            : "No pools listed yet. Paste a token address to look it up directly."}</p>
            : pools.map((pool) => <button type="button" key={pool.address}
              className={`${TABLE_GRID} min-h-[88px] w-full border-b border-[#29364a] bg-transparent text-left text-[.92rem] text-[#e9eef5] transition-[background] duration-160 ease-[ease] last:border-b-0 hover:bg-[#182333] focus-visible:bg-[#182333]`}
              onClick={() => onSelectPool(pool.address)} aria-label={`Add liquidity to the ${pool.token.symbol} / USDC pool`}>
              <span className="flex min-w-0 items-center gap-[13px] max-[800px]:col-span-full"><span className="grid size-[38px] flex-none place-items-center rounded-full border border-[#3c5e59] bg-[#123b35] text-[.75rem] font-bold text-[#62ddae]" aria-hidden="true">{pool.token.symbol.slice(0, 2).toUpperCase()}</span>
                <span><strong className="block overflow-hidden text-base text-ellipsis whitespace-nowrap">{pool.token.symbol} / USDC</strong><small className="mt-1 block font-mono text-[.72rem] text-[#a4b0c0]">Token {pool.token.address.slice(0, 6)}…{pool.token.address.slice(-4)}
                  {pool.hooks && pool.hooks.toLowerCase() !== zeroAddress ? " · Has extra pool rules" : ""}</small></span></span>
              <span className="tabular-nums"><small className={CELL_LABEL}>Token price</small>${formatPoolPrice(poolSpotPrice(pool))}</span>
              <span className="tabular-nums"><small className={CELL_LABEL}>USDC in pool</small>{pool.usdcReserve === null ? "—" :
                Number(formatUnits(BigInt(pool.usdcReserve), ARC_TOKENS.USDC.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
              <span className="tabular-nums"><small className={CELL_LABEL}>You earn per trade</small>{formatFeeTier(pool.fee)}</span>
              <span className="text-[.8rem] whitespace-nowrap text-[#39d7a1] max-[800px]:justify-self-end">Add liquidity <span aria-hidden="true">→</span></span>
            </button>)}
    </div>
    {offset > 0 || nextOffset !== null ? <div className="mt-5 flex items-center justify-center gap-4 text-[.85rem] text-[#b6c1d1]">
      <button className={`${OUTLINE_BUTTON} disabled:cursor-not-allowed disabled:opacity-40`} disabled={offset === 0} onClick={() => { setLoading(true); setOffset(Math.max(0, offset - 25)); }}>Previous</button>
      <span>Page {Math.floor(offset / 25) + 1}</span>
      <button className={`${OUTLINE_BUTTON} disabled:cursor-not-allowed disabled:opacity-40`} disabled={nextOffset === null} onClick={() => { setLoading(true); setOffset(nextOffset ?? offset); }}>Next</button>
    </div> : null}
    <p className="mt-[18px] text-[.75rem] leading-normal text-[#96a5b8]">Stillwater lists any pool it can work with. That doesn’t mean the token has been reviewed or is safe, so only add tokens you trust.</p>
  </section>;
}
