import { useState } from "react";
import { formatUsd, type Pond } from "../../lib/ponds";

export type PondAction = "collect" | "close" | "add" | "remove";

type Props = {
  ponds: Pond[];
  busy: boolean;
  collectAllUsd: number;
  onCollectAll: () => void;
  onAction: (pond: Pond, action: PondAction) => void;
};

const ACTIONS: { id: PondAction; label: string; v3Only?: boolean }[] = [
  { id: "collect", label: "Collect fees" },
  { id: "add", label: "Add more", v3Only: true },
  { id: "remove", label: "Remove some", v3Only: true },
  { id: "close", label: "Close pond" },
];

const GHOST = "min-h-11 rounded-full border border-line px-5 text-[1rem] font-medium text-ink hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50";

/** "Your ponds": one row per position, with its actions behind Manage. */
export function PondList({ ponds, busy, collectAllUsd, onCollectAll, onAction }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="ponds-title" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <h2 id="ponds-title" className="text-[2.1rem] font-semibold">Your ponds</h2>
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
        return (
          <div key={pond.key} className="border-b border-line">
            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,.7fr)_auto] items-center gap-4 py-6 text-[1.2rem] max-[760px]:grid-cols-[minmax(0,1fr)_auto] max-[760px]:gap-y-2">
              <span className="font-medium">{pond.pair}</span>
              <span className={`flex items-center gap-2.5 font-medium ${feeding ? "text-feed" : "text-rest"} max-[760px]:justify-self-end`}>
                <span className={`size-2.5 rounded-full ${feeding ? "bg-feed" : "bg-rest"}`} />
                {feeding ? "Feeding" : "Resting"}
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
            {expanded ? (
              <div className="flex flex-wrap gap-3 pb-6">
                {ACTIONS.filter((action) => !action.v3Only || pond.v3).map((action) => (
                  <button key={action.id} type="button" disabled={busy} onClick={() => onAction(pond, action.id)}
                    className={action.id === "close"
                      ? "min-h-11 rounded-full border border-danger-line bg-danger-soft px-5 text-[1rem] font-semibold text-danger hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                      : GHOST}>
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
