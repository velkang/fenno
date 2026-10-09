import { useMemo } from "react";
import type { WalletSummary, Waters } from "@stillwater/chain";
import { api, ApiError, type AuthUser, type ManagedWalletRecord } from "../lib/api-client";
import { Koi } from "../components/Icons";
import { pondFromV4, pondHeadline, pondsFromSummary, tomoNotes, type TomoNote } from "../lib/ponds";
import { ChooseWaters } from "../components/pond/ChooseWaters";
import { KoiBandCard } from "../components/pond/KoiBandCard";
import { TomoCard } from "../components/pond/TomoCard";
import { runFailureMessage, useAutomationRuns } from "../lib/automation";
import { useV4Ponds } from "../components/pond/useV4Ponds";

type Props = {
  user: AuthUser | null;
  wallet: ManagedWalletRecord | null;
  summary: WalletSummary | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
  onOpenPositions: () => void;
  onOpenAuth: () => void;
  onExplore: (waters?: Waters) => void;
  onOpenPool: (address: string) => void;
};

export function PondPage({ user, wallet, summary, onRefresh, onNotify, onOpenPositions, onOpenAuth, onExplore, onOpenPool }: Props) {
  const v4 = useV4Ponds(wallet, onRefresh, onNotify);
  const { runs, refresh: refreshRuns } = useAutomationRuns(wallet);
  const answer = async (note: TomoNote, approve: boolean) => {
    if (!note.proposal) return;
    try {
      await api.answerProposal(note.proposal.runId, approve);
      onNotify(approve ? "success" : "info", approve ? "Approved" : "Not now",
        approve ? "Pip is on it." : "Pip will look again later.");
    } catch (error) {
      onNotify("error", "Couldn't answer", error instanceof ApiError ? runFailureMessage(error.code) : "Try again.");
    }
    await refreshRuns();
  };
  const ponds = useMemo(() => [...v4.positions.map(pondFromV4), ...pondsFromSummary(summary)], [v4.positions, summary]);
  const gatheredUsd = ponds.reduce((sum, pond) => sum + (pond.gatheredUsd ?? 0), 0);
  // Feature the pond that needs attention first, else the most valuable one.
  const featured = [...ponds].sort((a, b) => Number(b.state !== "feeding") - Number(a.state !== "feeding")
    || (b.valueUsd ?? 0) - (a.valueUsd ?? 0))[0];
  const [line1, line2] = pondHeadline(ponds);
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }).toUpperCase();

  const openPondPool = (note: TomoNote) => {
    const pool = note.pond?.v4?.pool.address ?? note.pond?.v3?.pool.address;
    if (pool) onOpenPool(pool);
  };

  const empty = ponds.length === 0;
  return (
    <div className="mx-auto grid w-full max-w-[1280px] grid-cols-[minmax(0,1fr)_minmax(320px,420px)] items-start gap-[clamp(32px,4vw,56px)] pt-4 pb-12 max-[1040px]:grid-cols-1">
      <section aria-labelledby="pond-title" className="flex flex-col gap-9">
        <div className="flex flex-col gap-3.5">
          <p className="text-[.95rem] font-semibold tracking-[.14em] text-ink-muted">{today}</p>
          <h1 id="pond-title" className="text-[clamp(2.4rem,5vw,4rem)] leading-[1.12] font-semibold tracking-[-0.02em]">
            {line1}<br />{line2}
          </h1>
          {empty ? (
            <p className="mt-2 max-w-[640px] text-[1.3rem] leading-relaxed text-ink-muted">
              Add a token and USDC to a pool, and you earn a share of every trade while the price stays inside your band.
            </p>
          ) : null}
        </div>

        {empty ? (
          <>
            <div className="flex flex-wrap gap-3.5">
              <button type="button" onClick={() => onExplore()}
                className="min-h-[60px] rounded-full bg-accent px-8 text-[1.2rem] font-semibold text-on-accent hover:bg-accent-hover">
                Explore pools
              </button>
              {!user ? (
                <button type="button" onClick={onOpenAuth}
                  className="min-h-[60px] rounded-full border border-line px-8 text-[1.2rem] font-medium text-ink hover:bg-tint">
                  Sign in to start
                </button>
              ) : null}
            </div>
            <HowAPondWorks />
          </>
        ) : (
          <>
            {featured ? <KoiBandCard pond={featured} /> : null}
            <button type="button" onClick={onOpenPositions}
              className="min-h-14 self-start rounded-full border border-line px-7 text-[1.15rem] font-semibold text-ink hover:bg-tint">
              See your positions
            </button>
          </>
        )}
        {v4.error ? <p role="alert" className="text-danger">{v4.error}</p> : null}
      </section>

      <aside className="flex flex-col gap-11">
        <TomoCard notes={tomoNotes(ponds, gatheredUsd, runs)} onOpenPond={openPondPool} onAnswer={answer} />
        <ChooseWaters onChoose={onExplore} />
      </aside>
    </div>
  );
}

function HowAPondWorks() {
  const steps = [
    { title: "1 · Pick a pool", line: "A token paired with USDC. Calmer waters swing less." },
    { title: "2 · Set your band", line: "The price range you earn in. A wider band rests less often." },
    { title: "3 · Gather fees", line: "Collect them any time, or close the pond." },
  ];
  return (
    <article aria-labelledby="how-title" className="flex flex-col gap-6 rounded-[32px] bg-sage px-[clamp(20px,3.5vw,44px)] py-10">
      <span id="how-title" className="text-base font-semibold tracking-[.04em] text-ink-muted">HOW A POND WORKS</span>
      <div className="flex justify-center">
        <div className="flex h-[150px] w-[min(520px,100%)] items-center justify-center rounded-full border-2 border-dashed border-band bg-band-fill">
          <Koi size={110} role="img" aria-label="The koi: the price" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6 max-[760px]:grid-cols-1">
        {steps.map((step) => (
          <div key={step.title} className="flex flex-col gap-1.5">
            <span className="text-[1.25rem] font-semibold">{step.title}</span>
            <span className="text-[1.05rem] leading-relaxed text-ink-muted">{step.line}</span>
          </div>
        ))}
      </div>
      <p className="font-hand text-[1.9rem] text-hand">the koi is the price. while it swims in your band, you earn.</p>
    </article>
  );
}
