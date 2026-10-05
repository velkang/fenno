import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { reveal } from "../../lib/motion";
import { formatUsd, type Pond } from "../../lib/ponds";

export type PondAction = "collect" | "close" | "add" | "remove" | "recentre" | "care";

type Props = {
  ponds: Pond[];
  busy: boolean;
  collectAllUsd: number;
  onCollectAll: () => void;
  onAction: (pond: Pond, action: PondAction) => void;
  /** Ponds being re-centred right now, by key. */
  recentring?: ReadonlySet<string>;
  /** Ponds Tomo looks after, by key, and how. */
  cared?: ReadonlyMap<string, "ask" | "autopilot">;
};

const ACTIONS: { id: PondAction; label: string; v3Only?: boolean; v4Only?: boolean }[] = [
  { id: "recentre", label: "Re-centre band", v4Only: true },
  { id: "care", label: "Tomo's care", v4Only: true },
  { id: "collect", label: "Collect fees" },
  { id: "add", label: "Add more", v3Only: true },
  { id: "remove", label: "Remove some", v3Only: true },
  { id: "close", label: "Close pond" },
];

const GHOST = "min-h-11 rounded-full border border-line px-5 text-[1rem] font-medium text-ink hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50";

/** "Your positions": one row per position, with its actions behind Manage. */
export function PondList({ ponds, busy, collectAllUsd, onCollectAll, onAction, recentring, cared }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="ponds-title" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <h1 id="ponds-title" className="text-[2.4rem] font-semibold">Your positions</h1>
        {collectAllUsd > 0 ? (
          <button type="button" onClick={onCollectAll} disabled={busy}
            className="min-h-14 rounded-full bg-accent px-7 text-[1.15rem] font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
            Collect {formatUsd(collectAllUsd)}
          </button>
        ) : null}
      </div>
      {ponds.map((pond) => {
        const feeding = pond.state === "feeding";
        const expanded = open === pond.key;
        const moving = recentring?.has(pond.key) ?? false;
        return (
          <div key={pond.key} className="border-b border-line">
            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,.7fr)_auto] items-center gap-4 py-6 text-[1.2rem] max-[760px]:grid-cols-[minmax(0,1fr)_auto] max-[760px]:gap-y-2">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium">
                {pond.pair}
                {cared?.has(pond.key) ? (
                  <span className="whitespace-nowrap rounded-full bg-tint px-2.5 py-0.5 text-[.85rem] font-medium text-ink-muted">
                    {cared.get(pond.key) === "autopilot" ? "Tomo: autopilot" : "Tomo: asks first"}
                  </span>
                ) : null}
              </span>
              <span className={`flex items-center gap-2.5 font-medium ${moving ? "text-ink-muted" : feeding ? "text-feed" : "text-rest"} max-[760px]:justify-self-end`}>
                <span className={`size-2.5 rounded-full ${moving ? "animate-pulse bg-band" : feeding ? "bg-feed" : "bg-rest"}`} />
                {moving ? "Re-centring…" : feeding ? "Feeding" : "Resting"}
              </span>
              <span className="text-ink-muted tabular-nums">{formatUsd(pond.valueUsd)}</span>
              <span className="text-right font-semibold tabular-nums max-[760px]:text-left">
                {pond.gatheredUsd === null ? "—" : `+${formatUsd(pond.gatheredUsd)}`}
              </span>
              <button type="button" onClick={() => setOpen(expanded ? null : pond.key)} aria-expanded={expanded}
                className={`${GHOST} justify-self-end max-[760px]:col-span-full max-[760px]:justify-self-start`}>
                {expanded ? "Done" : "Manage"}
              </button>
            </div>
            <AnimatePresence initial={false}>
            {expanded ? (
              <motion.div key="actions" {...reveal} className="overflow-hidden">
              <div className="flex flex-wrap gap-3 pb-6">
                {ACTIONS.filter((action) => (!action.v3Only || pond.v3) && (!action.v4Only || pond.v4)).map((action) => (
                  <button key={action.id} type="button" disabled={busy || moving} onClick={() => onAction(pond, action.id)}
                    className={action.id === "close"
                      ? "min-h-11 rounded-full border border-danger-line bg-danger-soft px-5 text-[1rem] font-semibold text-danger hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                      : GHOST}>
                    {action.label}
                  </button>
                ))}
              </div>
              </motion.div>
            ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </section>
  );
}
