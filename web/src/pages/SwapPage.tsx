import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useChainId } from "wagmi";
import { ARC_CHAIN_ID, type AlphaWalletSummary } from "@stillwater/chain";
import { api, ApiError, type ManagedWalletRecord, type PublicPool } from "../lib/api-client";
import { formatFeeTier, formatPoolPrice, poolSpotPrice } from "./ExplorePage";
import { BalancePresets, useTokenBalance } from "../components/BalancePresets";
import { executePoolSwap, POOL_UNUSABLE_ERRORS, quotePoolSwap, swapDecimals, swapErrorMessage,
  type SwapQuote } from "../lib/swap-actions";

const CARD = "rounded-[14px] border border-[#29364a] bg-[#111827] p-6 max-[520px]:p-[18px]";
const NOTE_TEXT = "text-[.8rem] text-[#9eacc0]";
const FIELD_INPUT = "w-full rounded-[9px] border border-[#43536a] bg-[#151e2b] text-[#f3f4f6] focus:border-[#10b981] focus:shadow-[0_0_0_2px_#10b98133]";
const TAB_BUTTON = "border-b-2 border-transparent px-0.5 pb-3.5 text-[#9eacc0] aria-selected:border-[#10b981] aria-selected:text-[#4bdfa9]";
const DETAIL_ROW = "flex justify-between gap-3 py-[7px] text-[.78rem]";
const DETAIL_VALUE = "text-[#e5edf5] tabular-nums";
const PRIMARY_BUTTON = "mt-2.5 min-h-12 w-full rounded-[9px] bg-[#059669] font-[650] text-white disabled:cursor-not-allowed disabled:opacity-45";

type Props = {
  initialPoolAddress?: string;
  wallet: ManagedWalletRecord | null;
  summary: AlphaWalletSummary | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
  onSwapComplete?: () => void;
};

const errorCode = (reason: unknown) =>
  reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.message : "Try again.";
// After these, the reviewed quote is no longer usable and the user must review a new one.
const QUOTE_RESET_ERRORS = new Set([...POOL_UNUSABLE_ERRORS, "V4_QUOTE_STALE", "V4_APPROVAL_REQUIRED"]);

export function SwapPage({ initialPoolAddress, wallet, summary, onRefresh, onOpenAuth, onNotify, onSwapComplete }: Props) {
  const chainId = useChainId();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PublicPool[]>([]);
  const [pool, setPool] = useState<PublicPool | null>(null);
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poolQuoteUnavailable, setPoolQuoteUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const { data: tokenBalance, refetch: refetchTokenBalance, isError: tokenBalanceError } = useTokenBalance(pool?.token.address, wallet?.address);
  const pendingKey = wallet ? `stillwater_swap_attempt_${wallet.id}` : null;
  const [pendingAttempt, setPendingAttempt] = useState<string | null>(() =>
    wallet ? sessionStorage.getItem(`stillwater_swap_attempt_${wallet.id}`) : null);

  useEffect(() => {
    setPendingAttempt(pendingKey ? sessionStorage.getItem(pendingKey) : null);
  }, [pendingKey]);

  useEffect(() => {
    if (!initialPoolAddress) return;
    let current = true;
    api.getPool(initialPoolAddress).then(({ pool: selected }) => { if (current) setPool(selected); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "Pool not available"); });
    return () => { current = false; };
  }, [initialPoolAddress]);

  useEffect(() => {
    if (pool) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api.listPools(search).then(({ pools }) => { if (current) setResults(pools.slice(0, 8)); })
        .catch(() => { if (current) setResults([]); });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [search, pool]);

  useEffect(() => {
    setQuote(null);
    setReview(false);
    setError(null);
    setPoolQuoteUnavailable(false);
    if (!pool || !wallet || !amount || chainId !== ARC_CHAIN_ID) return;
    let raw: bigint;
    try { raw = parseUnits(amount, swapDecimals(pool, direction, "in")); }
    catch { return; }
    if (raw <= 0n) return;
    let current = true;
    const timer = window.setTimeout(() => {
      quotePoolSwap(pool, direction, raw)
        .then((result) => { if (current) { setQuote(result); setError(null); } })
        .catch((reason: unknown) => {
          if (!current) return;
          const code = errorCode(reason);
          setPoolQuoteUnavailable(POOL_UNUSABLE_ERRORS.has(code));
          setError(swapErrorMessage(code));
        });
    }, 350);
    return () => { current = false; window.clearTimeout(timer); };
  }, [pool, wallet, amount, direction, chainId]);

  const chooseAnotherPool = () => {
    if (pool) setSearch(pool.token.address);
    setPool(null);
    setError(null);
    setPoolQuoteUnavailable(false);
  };

  const executeAndWait = async (intentId: string) => {
    const executed = await api.executeIntent(intentId);
    if (pendingKey) sessionStorage.setItem(pendingKey, executed.attemptId);
    setPendingAttempt(executed.attemptId);
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const status = await api.reconcileAttempt(executed.attemptId);
      if (status.status === "confirmed") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        return true;
      }
      if (status.status !== "pending" && status.status !== "submitted") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        throw new Error(status.reasonCode || "Transaction did not confirm");
      }
    }
    throw new Error("Transaction is still pending. Refresh your wallet before retrying.");
  };

  const checkPending = async () => {
    if (!pendingAttempt) return;
    try {
      const result = await api.reconcileAttempt(pendingAttempt);
      if (result.status === "confirmed" || result.status === "failed") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        await onRefresh();
        onNotify("info", "Previous transaction settled", "Review your balances before continuing.");
      } else onNotify("info", "Transaction pending", "Please wait for confirmation before starting another swap.");
    } catch (reason) {
      onNotify("error", "Could not check transaction", reason instanceof Error ? reason.message : "Try again.");
    }
  };

  const submit = async () => {
    if (!pool || !quote || !wallet) return;
    setBusy(true);
    try {
      const completed = await executePoolSwap({ pool, direction, quote, execute: executeAndWait,
        onApprove: () => onNotify("info", "Approving swap input", "Stillwater will approve the exact input amount, then continue.") });
      if (!completed) return;
      onNotify("success", "Swap complete", `${direction === "buy" ? "Bought" : "Sold"} ${pool.token.symbol} in the selected pool.`);
      setAmount(""); setQuote(null); setReview(false);
      await Promise.all([onRefresh(), refetchTokenBalance()]);
      onSwapComplete?.();
    } catch (reason) {
      const code = errorCode(reason);
      if (QUOTE_RESET_ERRORS.has(code)) {
        setQuote(null);
        setReview(false);
        setPoolQuoteUnavailable(POOL_UNUSABLE_ERRORS.has(code));
        setError(swapErrorMessage(code));
      }
      onNotify("error", "Swap not completed", swapErrorMessage(code));
    } finally {
      setBusy(false);
    }
  };

  const outputDecimals = pool ? swapDecimals(pool, direction, "out") : 18;
  return <section className="m-auto max-w-[1180px] text-[#f3f4f6]" aria-labelledby="swap-title">
    <div className="mt-2 mb-7"><h1 id="swap-title" className="text-[2rem] font-bold tracking-[-.03em]">Swap</h1><p className="mt-2 text-[#b6c1d1]">Trade in one selected Arc pool. Stillwater does not search for a better route.</p></div>
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(350px,.8fr)] items-start gap-[22px] max-[800px]:grid-cols-1"><div className={CARD}><h2 className="mb-5 text-[1.15rem] font-[650]">Choose a pool</h2>
      {pool ? <div className="grid gap-[9px]"><strong className="text-[1.35rem]">{pool.token.symbol} / USDC</strong>
        <span className={NOTE_TEXT}>Fee {formatFeeTier(pool.fee)} · Pool spot ${formatPoolPrice(poolSpotPrice(pool))}</span>
        <code className={`${NOTE_TEXT} wrap-anywhere`}>{pool.address}</code><button type="button" className="mt-2.5 justify-self-start text-[#5be2b0]" onClick={chooseAnotherPool}>Change pool</button></div>
        : <><input className={FIELD_INPUT} aria-label="Search token or contract address" value={search}
          onChange={(event) => setSearch(event.target.value)} placeholder="Search token or paste contract address" />
          <div className="mt-3.5 grid">{results.map((candidate) => <button type="button" key={candidate.address}
            className="flex justify-between gap-[15px] border-b border-[#29364a] px-0.5 py-[15px] text-left text-[#eef3f7] hover:text-[#51dcaa] max-[520px]:grid"
            onClick={() => { setPool(candidate); setSearch(""); }}><strong>{candidate.token.symbol} / USDC</strong>
            <span className={NOTE_TEXT}>{formatFeeTier(candidate.fee)} fee · {candidate.token.address.slice(0, 10)}…</span></button>)}
            {results.length === 0 ? <p className="py-6 text-[#aebbc9]">No eligible pools found. Try a contract address.</p> : null}</div></>}
      <p className={`${NOTE_TEXT} mt-[22px] leading-normal`}>A listed pool is technically compatible, not a token safety endorsement.</p>
    </div>
    <div className={CARD}><div className="mb-6 flex gap-[22px] border-b border-[#29364a]" role="tablist" aria-label="Swap direction">
      <button role="tab" className={TAB_BUTTON} aria-selected={direction === "buy"} onClick={() => { setDirection("buy"); setAmount(""); }}>Buy token</button>
      <button role="tab" className={TAB_BUTTON} aria-selected={direction === "sell"} onClick={() => { setDirection("sell"); setAmount(""); }}>Sell token</button></div>
      <label className="block text-[.83rem] text-[#b6c1d1]">You pay <span className="float-right font-semibold text-[#f3f4f6]">{direction === "buy" ? "USDC" : pool?.token.symbol ?? "Token"}</span>
        <input className={`${FIELD_INPUT} mt-2.5 h-[66px] text-[1.45rem] tabular-nums`} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" /></label>
      {direction === "buy" && summary ? <p className="mt-2.5 mb-6 text-[.78rem] text-[#9eacc0]">Wallet: {Number(formatUnits(BigInt(summary.balances.nativeUsdc.raw), 18)).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC · fees use this balance too</p> : null}
      {direction === "sell" && wallet && pool ? <BalancePresets balance={tokenBalance} decimals={pool.token.decimals}
        symbol={pool.token.symbol} presets unavailable={tokenBalanceError} onSelect={setAmount} /> : null}
      <div className="flex justify-between gap-2.5 border-t border-[#29364a] py-5"><span className="text-[.83rem] text-[#b6c1d1]">Estimated receive</span><strong className="text-right tabular-nums">{quote ? formatUnits(BigInt(quote.expectedAmountOut), outputDecimals) : "—"} {direction === "buy" ? pool?.token.symbol : "USDC"}</strong></div>
      {quote ? <dl className="border-t border-[#29364a] py-3.5"><div className={DETAIL_ROW}><dt className="text-[#9eacc0]">Minimum receive (1% slippage)</dt><dd className={DETAIL_VALUE}>{formatUnits(BigInt(quote.minimumAmountOut), outputDecimals)}</dd></div>
        <div className={DETAIL_ROW}><dt className="text-[#9eacc0]">Pool fee</dt><dd className={DETAIL_VALUE}>{formatFeeTier(pool?.fee)}</dd></div>
        <div className={DETAIL_ROW}><dt className="text-[#9eacc0]">Route</dt><dd className={DETAIL_VALUE}>Single pool</dd></div></dl> : null}
      {error ? <div className="my-2.5 text-[.8rem] text-[#fda4af]" role="alert"><p>{error}</p>
        {poolQuoteUnavailable ? <button type="button" className="mt-2 text-[#f3f4f6] underline underline-offset-3" onClick={chooseAnotherPool}>Choose another {pool?.token.symbol}/USDC pool</button> : null}
      </div> : null}
      {pendingAttempt ? <button type="button" onClick={() => void checkPending()}>Check pending transaction</button> : null}
      {!wallet ? <button className={PRIMARY_BUTTON} type="button" onClick={onOpenAuth}>Sign in to swap</button>
        : <button className={PRIMARY_BUTTON} type="button" disabled={!pool || !quote || busy || pendingAttempt !== null || chainId !== ARC_CHAIN_ID}
          onClick={() => { if (review) void submit(); else setReview(true); }}>
          {busy ? "Processing…" : review ? "Confirm swap" : "Review swap"}</button>}
      {review && quote ? <p className="mt-3.5 text-[.78rem] leading-normal text-[#b6c1d1]">Stillwater will use up to {amount} {direction === "buy" ? "USDC" : pool?.token.symbol}, approve that exact amount if required, and stop if output falls below the minimum shown.</p> : null}
    </div></div>
  </section>;
}
