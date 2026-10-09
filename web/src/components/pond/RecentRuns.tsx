import type { AutomationRun } from "../../lib/api-client";
import { runFailureMessage } from "../../lib/automation";

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

/** What Tomo has done in one pond's pool, and why: shown in that pond's Manage area. */
export function RecentRuns({ runs }: { runs: AutomationRun[] }) {
  if (runs.length === 0) return null;
  return (
    <section aria-label="Pip's recent work" className="flex flex-col gap-1 border-t border-line pt-4">
      <h3 className="text-[1rem] font-semibold">Pip's recent work</h3>
      <ul className="flex flex-col">
        {runs.slice(0, SHOWN).map((run) => (
          <li key={run.id} className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0">
            <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="font-medium">{what(run)}</span>
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
