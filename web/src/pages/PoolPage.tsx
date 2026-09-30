import { useEffect, useRef, useState, type ReactNode } from "react";
import { tokenWaters, type AlphaWalletSummary, type Waters } from "@stillwater/chain";
import { WaterMark } from "../components/Icons";
import { useTokenBalance } from "../components/BalancePresets";
import { Loading, Skeleton } from "../components/Skeleton";
import { api, type ManagedWalletRecord, type PublicPool } from "../lib/api-client";
import { DepositPage } from "./DepositPage";
import { SwapPage } from "./SwapPage";
import { formatPoolPrice, PAGE_INTRO, PAGE_TITLE, poolSpotPrice } from "./ExplorePage";

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
  // Buying the pool's token happens in a drawer over the Add liquidity form.
  const [buying, setBuying] = useState(false);
  // Bumped after a swap so the form reloads its balances.
  const [swaps, setSwaps] = useState(0);
  // Shares its cache with the swap drawer, so a completed buy updates it too.
  const { data: tokenBalance } = useTokenBalance(pool?.token.address, wallet?.address);

  useEffect(() => {
    let current = true;
    setPool(null);
    setError(null);
    setBuying(false);
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
  if (!pool) return <PoolSkeleton />;
  const tierId = tokenWaters(pool.token.address);
  const tier = TIER[tierId];

  // 0x800000 marks a v4 pool whose fee changes trade by trade.
  const fee = pool.fee === 0x800000 ? "a varying share" : `${(pool.fee / 10_000).toFixed(2)}%`;

  return <div className="mx-auto w-full max-w-[1280px] text-ink">
    <div className="mb-7 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-6 max-[900px]:grid-cols-1">
      <div className="flex flex-col gap-3">
        {onBack ? <button type="button" onClick={onBack} className="min-h-10 self-start text-[1.05rem] text-link">← All pools</button> : null}
        <h1 className={PAGE_TITLE}>{pool.token.symbol} / USDC</h1>
        <p className={PAGE_INTRO}>Earn {fee} of every trade in this pool by adding {pool.token.symbol} and USDC. {pool.token.symbol} is ${formatPoolPrice(poolSpotPrice(pool))} now.</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 max-[900px]:justify-start">
        <span className={`inline-flex min-h-11 items-center gap-2.5 rounded-full border px-4 text-[1.02rem] font-semibold whitespace-nowrap ${tier.tone}`}>
          <WaterMark tier={tierId} className="h-4 w-9" />{tier.label}</span>
        {/* Holding none? The amounts form offers "Buy" in place of the presets instead. */}
        {wallet && tokenBalance !== undefined && tokenBalance > 0n ? <button type="button" onClick={() => setBuying(true)}
          className="min-h-11 rounded-full border border-line px-5 text-[1.02rem] font-semibold text-ink hover:bg-tint">
          Buy more {pool.token.symbol}
        </button> : null}
      </div>
    </div>
    <DepositPage initialPoolAddress={address} initialTokenAddress={pool.token.address} pool={pool}
      balancesKey={swaps} onBuyToken={() => setBuying(true)} wallet={wallet} summary={summary} onRefresh={onRefresh}
      onNotify={onNotify} onOpenAuth={onOpenAuth} />
    {buying ? <BuyDrawer symbol={pool.token.symbol} onClose={() => setBuying(false)}>
      <SwapPage initialPoolAddress={address} wallet={wallet} summary={summary}
        onRefresh={onRefresh} onOpenAuth={onOpenAuth} onNotify={onNotify}
        onSwapComplete={() => { setSwaps((count) => count + 1); setBuying(false); }} />
    </BuyDrawer> : null}
  </div>;
}

/** A side sheet for buying the pool's token without leaving the Add liquidity form. */
function BuyDrawer({ symbol, onClose, children }: { symbol: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Focus once on open; Escape closes. Not re-run per render, so typing in the swap keeps focus.
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return <div className="fixed inset-0 z-70 flex justify-end bg-scrim text-ink"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="buy-drawer-title"
      className="flex h-full w-[min(560px,100%)] flex-col gap-6 overflow-auto overscroll-contain rounded-l-[28px] bg-paper p-8 shadow-2xl max-[520px]:rounded-none max-[520px]:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 id="buy-drawer-title" className="text-[2rem] font-semibold">Buy {symbol}</h2>
          <p className="text-[1rem] leading-relaxed text-ink-muted">A position holds both {symbol} and USDC. Swap some USDC for {symbol}, then add liquidity.</p>
        </div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close"
          className="min-h-11 rounded-full border border-line px-5 text-[1rem] font-medium text-ink hover:bg-tint">Close</button>
      </div>
      {children}
    </section>
  </div>;
}

function PoolSkeleton() {
  return <Loading label="Loading the pool…" className="mx-auto flex w-full max-w-[1280px] flex-col">
    <div className="mb-7 flex flex-wrap items-end justify-between gap-6">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-5 w-[min(560px,80vw)]" />
      </div>
      <Skeleton className="h-11 w-36" />
    </div>
    <div className="mb-7 flex gap-9 border-b border-line pb-3">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-6 w-36" />
    </div>
    <Skeleton className="h-[360px] w-full max-w-[720px] rounded-[28px]" />
  </Loading>;
}
