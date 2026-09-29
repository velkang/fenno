import { useEffect, useState } from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { api, type ManagedWalletRecord, type PublicPool } from "../lib/api-client";
import { ensureV4Allowance } from "../lib/v4-actions";

const PANEL = "max-w-[760px] rounded-[14px] border border-[#29364a] bg-[#111827] p-6 max-[600px]:p-[18px]";
const BODY_TEXT = "leading-normal text-[#b6c1d1]";
const REVIEW = "mt-5 border-t border-[#29364a] pt-[18px]";
const BUTTON_BASE = "min-h-11 rounded-[9px] px-4 py-2.5 font-bold disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON = `${BUTTON_BASE} bg-[#0ba879] text-[#061a15]`;
const DIRECTION_BUTTON = `${BUTTON_BASE} bg-[#1b2938] text-[#b6c1d1] aria-pressed:bg-[#0ba879] aria-pressed:text-[#061a15]`;

type Props = {
  pool: PublicPool;
  wallet: ManagedWalletRecord | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
  onSwapComplete?: () => void;
};

export function V4SwapPanel({ pool, wallet, onRefresh, onOpenAuth, onNotify, onSwapComplete }: Props) {
  const nativeUsdc = pool.token0.toLowerCase() === zeroAddress || pool.token1.toLowerCase() === zeroAddress;
  const [loading, setLoading] = useState(false);
  const [swapDirection, setSwapDirection] = useState<"buy" | "sell">("buy");
  const [swapAmount, setSwapAmount] = useState("");
  const [swapQuote, setSwapQuote] = useState<Awaited<ReturnType<typeof api.quoteV4Swap>> | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const pendingKey = wallet ? `actora-v4-pending:${wallet.id}:${pool.address}` : null;
  const [pendingAttempt, setPendingAttempt] = useState<string | null>(() => pendingKey ? sessionStorage.getItem(pendingKey) : null);

  useEffect(() => { setPendingAttempt(pendingKey ? sessionStorage.getItem(pendingKey) : null); }, [pendingKey]);

  const executeAndWait = async (intentId: string) => {
    const result = await api.executeIntent(intentId);
    if (pendingKey) sessionStorage.setItem(pendingKey, result.attemptId);
    setPendingAttempt(result.attemptId);
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const receipt = await api.reconcileAttempt(result.attemptId);
      if (receipt.status === "confirmed") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        return true;
      }
      if (receipt.status !== "pending" && receipt.status !== "submitted") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        throw new Error(receipt.reasonCode || "Transaction did not confirm");
      }
    }
    onNotify("info", "Transaction pending", "Actora is still tracking the transaction on Arc.");
    return false;
  };

  const checkPending = async () => {
    if (!pendingAttempt) return;
    try {
      const receipt = await api.reconcileAttempt(pendingAttempt);
      if (receipt.status !== "pending" && receipt.status !== "submitted") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        setSwapQuote(null);
        setSwapError(null);
        await onRefresh();
        onNotify("info", "Previous transaction settled", "Review your balances before continuing.");
      } else onNotify("info", "Transaction pending", "Wait for confirmation before continuing.");
    } catch (caught) {
      setSwapError(caught instanceof Error ? caught.message : "Could not check transaction.");
    }
  };

  const usdcCurrency = nativeUsdc ? zeroAddress : "0x3600000000000000000000000000000000000000";
  const swapTokenIn = swapDirection === "buy" ? usdcCurrency : pool.token.address;
  const swapDecimals = swapDirection === "buy" ? nativeUsdc ? 18 : 6 : pool.token.decimals;
  const swapRawAmount = () => {
    const amount = parseUnits(swapAmount.trim(), swapDecimals);
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
    return amount;
  };
  const handleSwapQuote = async () => {
    setLoading(true);
    setSwapError(null);
    setSwapQuote(null);
    try {
      const result = await api.quoteV4Swap({ poolId: pool.address, tokenIn: swapTokenIn,
        amountIn: swapRawAmount().toString(), slippageBps: 100 });
      setSwapQuote(result);
    } catch (caught) { setSwapError(caught instanceof Error ? caught.message : "Could not quote swap."); }
    finally { setLoading(false); }
  };
  const handleSwap = async () => {
    if (!swapQuote) return;
    setLoading(true);
    setSwapError(null);
    try {
      const amountIn = swapRawAmount();
      const originalMinimum = BigInt(swapQuote.minimumAmountOut);
      const approved = await ensureV4Allowance({ poolId: pool.address, token: swapTokenIn,
        amount: amountIn, purpose: "swap", execute: executeAndWait,
        onApprove: (stage) => onNotify("info", "Preparing swap",
          `Confirming ${stage === "erc20" ? "token" : "router"} approval.`) });
      if (!approved) return;
      const freshQuote = await api.quoteV4Swap({ poolId: pool.address, tokenIn: swapTokenIn,
        amountIn: amountIn.toString(), slippageBps: 100 });
      if (BigInt(freshQuote.expectedAmountOut) < originalMinimum) {
        setSwapQuote(null);
        throw new Error("The pool price moved beyond your reviewed minimum. Get a new quote to continue.");
      }
      const minimumAmountOut = BigInt(freshQuote.minimumAmountOut) > originalMinimum
        ? freshQuote.minimumAmountOut : originalMinimum.toString();
      const preparedSwap = await api.prepareV4Swap({ poolId: pool.address, tokenIn: swapTokenIn,
        amountIn: amountIn.toString(), slippageBps: 100,
        minimumAmountOut,
        idempotencyKey: crypto.randomUUID() });
      if (await executeAndWait(preparedSwap.intentId)) {
        setSwapQuote(null);
        setSwapAmount("");
        await onRefresh();
        onNotify("success", "Swap confirmed", `You now hold both tokens. Continue to add liquidity.`);
        onSwapComplete?.();
      }
    } catch (caught) {
      if (caught instanceof Error && ["V4_QUOTE_STALE", "V4_APPROVAL_REQUIRED"].includes(caught.message)) {
        setSwapQuote(null);
      }
      setSwapError(caught instanceof Error ? caught.message : "Swap failed.");
    }
    finally { setLoading(false); }
  };

  if (!wallet) return <section className={PANEL}><p className={BODY_TEXT}>Connect your owner wallet to swap in this pool.</p>
    <button type="button" className={PRIMARY_BUTTON} onClick={onOpenAuth}>Connect wallet</button></section>;

  return <section className={PANEL}>
    <div className="mb-6 border-b border-[#29364a] pb-6" aria-labelledby="v4-swap-title">
      <h2 id="v4-swap-title" className="mt-0 mb-2 text-[1.35rem]">Swap in this pool</h2>
      <p className={BODY_TEXT}>Buy {pool.token.symbol} with USDC before adding liquidity, or sell it back to USDC. Each swap uses this one pool.</p>
      {pendingAttempt ? <div role="status" className={REVIEW}><p className={BODY_TEXT}>A previous transaction is still being tracked.</p>
        <button type="button" className={PRIMARY_BUTTON} disabled={loading} onClick={checkPending}>Check transaction</button></div> : null}
      <div className="flex gap-2" role="group" aria-label="Swap direction">
        <button type="button" className={DIRECTION_BUTTON} aria-pressed={swapDirection === "buy"} onClick={() => { setSwapDirection("buy"); setSwapQuote(null); setSwapError(null); }}>Buy</button>
        <button type="button" className={DIRECTION_BUTTON} aria-pressed={swapDirection === "sell"} onClick={() => { setSwapDirection("sell"); setSwapQuote(null); setSwapError(null); }}>Sell</button>
      </div>
      <label className="my-[18px] grid max-w-[340px] gap-2">Amount in ({swapDirection === "buy" ? "USDC" : pool.token.symbol})
        <input className="min-h-12 w-full rounded-[9px] border border-[#344256] bg-[#151e2b] px-3 py-2.5 text-[#f3f4f6]" inputMode="decimal" value={swapAmount} onChange={(event) => { setSwapAmount(event.target.value); setSwapQuote(null); setSwapError(null); }} placeholder="0.0" /></label>
      {swapError ? <p role="alert" className="leading-normal text-[#fda4af]">{swapError === "V4_QUOTE_STALE" ?
        "The pool price changed. Get a new quote before swapping." : swapError === "V4_APPROVAL_REQUIRED" ?
          "Your approval changed or expired. Get a new quote to continue." : swapError === "V4_SWAP_SIMULATION_FAILED" ?
            "This pool's swap could not be simulated. No swap was sent. Try another pool." : swapError}</p> : null}
      {swapQuote ? <div className={REVIEW}><p className={BODY_TEXT}>Expected: {formatUnits(BigInt(swapQuote.expectedAmountOut), swapDirection === "buy" ? pool.token.decimals : nativeUsdc ? 18 : 6)} {swapDirection === "buy" ? pool.token.symbol : "USDC"}</p>
        <p className={BODY_TEXT}>Minimum after 1% slippage: {formatUnits(BigInt(swapQuote.minimumAmountOut), swapDirection === "buy" ? pool.token.decimals : nativeUsdc ? 18 : 6)}</p>
        <p className={BODY_TEXT}>Confirm once. Actora will complete any needed approvals before the swap.</p>
        <button type="button" className={PRIMARY_BUTTON} disabled={loading || !!pendingAttempt} onClick={handleSwap}>{loading ? "Processing…" : `Confirm swap`}</button>
      </div> : <button type="button" className={PRIMARY_BUTTON} disabled={loading || !!pendingAttempt || !swapAmount} onClick={handleSwapQuote}>Get swap quote</button>}
    </div>
  </section>;
}
