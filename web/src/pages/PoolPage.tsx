import { useEffect, useState } from "react";
import { tokenWaters, type AlphaWalletSummary, type Waters } from "@stillwater/chain";
import { WaterMark } from "../components/Icons";
import { api, type ManagedWalletRecord, type PublicPool } from "../lib/api-client";
import { DepositPage } from "./DepositPage";
import { SwapPage } from "./SwapPage";
import { formatPoolPrice, PAGE_INTRO, PAGE_TITLE, poolSpotPrice } from "./ExplorePage";

const STEP_BUTTON = "min-h-12 border-b-2 border-transparent pb-3 text-[1.15rem] text-ink-muted aria-pressed:border-ink aria-pressed:font-semibold aria-pressed:text-ink";

const TIER: Record<Waters, { label: string; tone: string }> = {
  still: { label: "Still water · a stablecoin pair, calm", tone: "border-feed-line text-feed" },
  gentle: { label: "Gentle stream · an established token", tone: "border-rest-line text-rest" },
  rapids: { label: "Rapids · a new token, big swings", tone: "border-danger-line text-danger" },
};

type Props = {
  address: string;
  onBack?: () => void;
  wallet: ManagedWalletRecord | null;
  summary: AlphaWalletSummary | null;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
};

export function PoolPage({ address, onBack, wallet, summary, onRefresh, onOpenAuth, onNotify }: Props) {
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

  if (error) return <section role="alert" className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 pt-6">
    <h1 className={PAGE_TITLE}>This pool isn&apos;t available</h1>
    <p className={PAGE_INTRO}>Stillwater couldn&apos;t read it just now ({error}). Try again in a moment, or pick another pool.</p>
    {onBack ? <button type="button" onClick={onBack} className="mt-2 min-h-12 self-start rounded-full border border-line px-6 text-[1.05rem] font-medium hover:bg-tint">← All pools</button> : null}
  </section>;
  if (!pool) return <p role="status" className="mx-auto w-full max-w-[1280px] pt-10 text-[1.1rem] text-ink-muted">Reading the pool from Arc…</p>;
  const tierId = tokenWaters(pool.token.address);
  const tier = TIER[tierId];

  // 0x800000 marks a v4 pool whose fee changes trade by trade.
  const fee = pool.fee === 0x800000 ? "a varying share" : `${(pool.fee / 10_000).toFixed(2)}%`;

  return <div className="mx-auto w-full max-w-[1280px] text-ink">
    <div className="mb-7 flex flex-wrap items-end justify-between gap-6">
      <div className="flex flex-col gap-3">
        {onBack ? <button type="button" onClick={onBack} className="min-h-10 self-start text-[1.05rem] text-link">← All pools</button> : null}
        <h1 className={PAGE_TITLE}>{pool.token.symbol} / USDC</h1>
        <p className={PAGE_INTRO}>Earn {fee} of every trade in this pool by adding {pool.token.symbol} and USDC. {pool.token.symbol} is ${formatPoolPrice(poolSpotPrice(pool))} now.</p>
      </div>
      <span className={`inline-flex min-h-11 items-center gap-2.5 rounded-full border px-4 text-[1.02rem] font-semibold whitespace-nowrap ${tier.tone}`}>
        <WaterMark tier={tierId} className="h-4 w-9" />{tier.label}</span>
    </div>
    <div className="mb-7 flex gap-9 border-b border-line" role="group" aria-label="Add liquidity steps">
      <button type="button" className={STEP_BUTTON}
        aria-pressed={step === "fund"} onClick={() => setStep("fund")}>1 · Get both tokens</button>
      <button type="button" className={STEP_BUTTON}
        aria-pressed={step === "position"} onClick={() => setStep("position")}>2 · Add liquidity</button>
    </div>
    {step === "fund" ? <>
      <p className="mb-6 max-w-[70ch] text-[1.1rem] leading-relaxed text-ink-muted">A pond holds both {pool.token.symbol} and USDC. If your Stillwater wallet only has USDC, buy some {pool.token.symbol} here first, then continue.</p>
      <SwapPage initialPoolAddress={address} wallet={wallet} summary={summary}
        onRefresh={onRefresh} onOpenAuth={onOpenAuth} onNotify={onNotify}
        onSwapComplete={() => setStep("position")} />
      <button type="button" className="mt-6 min-h-11 text-[1.05rem] font-medium text-link underline underline-offset-4" onClick={() => setStep("position")}>I already have both tokens</button>
    </> : <DepositPage initialPoolAddress={address} initialTokenAddress={pool.token.address} pool={pool}
      onNeedTokens={() => setStep("fund")} wallet={wallet} summary={summary} onRefresh={onRefresh}
      onNotify={onNotify} onOpenAuth={onOpenAuth} />}
  </div>;
}
