import type { AutomationRun } from "../../lib/api-client";
import { runFailureMessage } from "../../lib/automation";
import type { Pond } from "../../lib/ponds";

const SHOWN = 5;

function what(run: AutomationRun): string {
  const closing = run.kind === "close";
  switch (run.status) {
    case "proposed": return closing ? "Suggested closing" : "Suggested re-centring";
    case "running": return closing ? "Closing…" : "Re-centring…";
    case "done": return closing ? "Closed" : "Re-centred";
    case "failed": return `${closing ? "Closing" : "Re-centring"} stopped: ${runFailureMessage(run.failureReason)}`;
    case "declined": return "Suggestion declined";
    case "expired": return "Suggestion lapsed";
  }
}

/** Tomo's recent work on the wallet's ponds: what was done, and why. */
export function RecentRuns({ runs, ponds }: { runs: AutomationRun[]; ponds: Pond[] }) {
  if (runs.length === 0) return null;
  const pair = (run: AutomationRun) => ponds.find((pond) =>
    pond.poolId.toLowerCase() === run.poolId.toLowerCase())?.pair ?? "A pond";
  return (
    <section aria-labelledby="runs-title" className="flex flex-col gap-3 pt-4">
      <h2 id="runs-title" className="text-[1.4rem] font-semibold">Tomo's recent work</h2>
      <ul className="flex flex-col">
        {runs.slice(0, SHOWN).map((run) => (
          <li key={run.id} className="flex flex-col gap-1 border-b border-line py-4">
            <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="font-medium">{pair(run)} · {what(run)}</span>
              <time dateTime={new Date(run.createdAt).toISOString()} className="text-[.9rem] text-ink-muted tabular-nums">
                {new Date(run.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </time>
            </span>
            <span className="text-[.95rem] leading-relaxed text-ink-muted">
              {run.trigger === "user" ? "You started this." : run.reason ?? ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
