import { useEffect, useState } from "react";
import type { AlphaWalletSummary } from "@stillwater/chain";
import { api, type ManagedWalletRecord, type PublicPool } from "../lib/api-client";
import { DepositPage } from "./DepositPage";
import { SwapPage } from "./SwapPage";
import { formatPoolPrice, PAGE_INTRO, PAGE_TITLE, poolSpotPrice } from "./ExplorePage";

const STEP_BUTTON = "min-h-11 border-b-2 border-transparent px-4 py-3 text-[#b6c1d1] aria-pressed:border-[#10b981] aria-pressed:text-[#6ee7b7]";

type Props = {
  address: string;
  wallet: ManagedWalletRecord | null;
  summary: AlphaWalletSummary | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
};

export function PoolPage({ address, wallet, summary, onRefresh, onOpenAuth, onNotify }: Props) {
  const [pool, setPool] = useState<PublicPool | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"fund" | "position">("position");

  useEffect(() => {
    let current = true;
    setPool(null);
    setError(null);
    setStep("position");
    api.getPool(address).then((result) => {
      if (current) setPool(result.pool);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Pool unavailable");
    });
    return () => { current = false; };
  }, [address]);

  if (error) return <section role="alert"><h1>Pool unavailable</h1><p>{error}</p></section>;
  if (!pool) return <p role="status">Loading pool…</p>;

  // 0x800000 marks a v4 pool whose fee changes trade by trade.
  const fee = pool.fee === 0x800000 ? "a varying share" : `${(pool.fee / 10_000).toFixed(2)}%`;

  return <div className="text-[#f3f4f6]">
    <div className="mt-2 mb-7 flex items-end justify-between gap-6 max-[520px]:block">
      <div><h1 className={PAGE_TITLE}>{pool.token.symbol} / USDC</h1>
        <p className={PAGE_INTRO}>Earn {fee} of every trade in this pool by adding {pool.token.symbol} and USDC. {pool.token.symbol} is ${formatPoolPrice(poolSpotPrice(pool))} now.</p></div>
    </div>
    <div className="mb-6 flex gap-2 border-b border-[#29364a]" role="group" aria-label="Add liquidity steps">
      <button type="button" className={STEP_BUTTON}
        aria-pressed={step === "fund"} onClick={() => setStep("fund")}>1 · Get both tokens</button>
      <button type="button" className={STEP_BUTTON}
        aria-pressed={step === "position"} onClick={() => setStep("position")}>2 · Add liquidity</button>
    </div>
    {step === "fund" ? <>
      <p className="my-4 max-w-[70ch] leading-normal text-[#b6c1d1]">A position holds both {pool.token.symbol} and USDC. If your Stillwater wallet only has USDC, buy some {pool.token.symbol} here first, then continue.</p>
      <SwapPage initialPoolAddress={address} wallet={wallet} summary={summary}
        onRefresh={onRefresh} onOpenAuth={onOpenAuth} onNotify={onNotify}
        onSwapComplete={() => setStep("position")} />
      <button type="button" className="mb-6 min-h-11 text-[#6ee7b7] underline underline-offset-3" onClick={() => setStep("position")}>I already have both tokens</button>
    </> : <DepositPage initialPoolAddress={address} initialTokenAddress={pool.token.address} pool={pool}
      onNeedTokens={() => setStep("fund")} wallet={wallet} summary={summary} onRefresh={onRefresh}
      onNotify={onNotify} onOpenAuth={onOpenAuth} />}
  </div>;
}
