import { useEffect, useState } from "react";
import { api, ApiError, type AuthUser, type AutomationAlert } from "../lib/api-client";
import { alertAt, runFailureMessage, type useAlerts } from "../lib/automation";
import { Loading, Skeleton } from "../components/Skeleton";

type Props = {
  user: AuthUser | null;
  alerts: ReturnType<typeof useAlerts>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
  onOpenPositions: () => void;
  onOpenAuth: () => void;
};

function headline(alert: AutomationAlert): string {
  const pond = alert.symbol ? `your ${alert.symbol} pond` : "a pond";
  const closing = alert.kind === "close";
  switch (alert.status) {
    case "proposed": return `Pip suggests ${closing ? "closing" : "re-centring"} ${pond}`;
    case "running": return `${closing ? "Closing" : "Re-centring"} ${pond}…`;
    case "done": return `${closing ? "Closed" : "Re-centred"} ${pond}`;
    case "failed": return `Couldn't ${closing ? "close" : "re-centre"} ${pond}`;
    case "declined": return `You turned down a change to ${pond}`;
    case "expired": return `A suggestion for ${pond} lapsed`;
  }
}

const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Tomo's alerts across every pond: what it suggests, did, or couldn't finish. */
export function AlertsPage({ user, alerts: { alerts, seenAt, loaded, unread, refresh, markSeen }, onNotify, onOpenPositions, onOpenAuth }: Props) {
  // What was new when the page opened stays marked while it's open, though it's now seen.
  const [newSince, setNewSince] = useState<number | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && newSince === null) setNewSince(seenAt ?? 0);
  }, [loaded, newSince, seenAt]);
  useEffect(() => {
    if (newSince !== null && unread) void markSeen();
  }, [newSince, unread, markSeen]);

  const answer = async (alert: AutomationAlert, approve: boolean) => {
    setAnswering(alert.id);
    try {
      await api.answerProposal(alert.id, approve);
      onNotify(approve ? "success" : "info", approve ? "Approved" : "Not now",
        approve ? "Pip is on it." : "Pip will look again later.");
    } catch (error) {
      onNotify("error", "Couldn't answer", error instanceof ApiError ? runFailureMessage(error.code) : "Try again.");
    }
    await refresh();
    setAnswering(null);
  };

  if (!user) {
    return (
      <section className="mx-auto flex max-w-[820px] flex-col items-start gap-5">
        <h1 className="text-[2.4rem] font-semibold">Alerts</h1>
        <p className="text-[1.1rem] text-ink-muted">Sign in to see what Pip has been doing.</p>
        <button type="button" onClick={onOpenAuth}
          className="min-h-12 whitespace-nowrap rounded-full bg-accent px-7 font-semibold text-on-accent hover:bg-accent-hover">
          Sign in
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="alerts-title" className="mx-auto flex max-w-[820px] flex-col">
      <h1 id="alerts-title" className="border-b border-line pb-5 text-[2.4rem] font-semibold">Alerts</h1>
      {!loaded ? (
        <Loading label="Loading alerts…" className="flex flex-col gap-3 py-6">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-6 w-1/2" />
        </Loading>
      ) : alerts.length === 0 ? (
        <p className="py-6 text-[1.1rem] text-ink-muted">Nothing yet. Pip's suggestions and changes show up here.</p>
      ) : (
        <ul className="flex flex-col">
          {alerts.map((alert) => {
            const fresh = newSince !== null && alertAt(alert) > newSince;
            const pondGone = alert.kind === "close" && alert.status === "done";
            return (
              <li key={alert.id} className="flex flex-col gap-2 border-b border-line py-5">
                <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[1.15rem] font-medium">
                    {headline(alert)}
                    {fresh ? <span className="whitespace-nowrap rounded-full bg-feed-soft px-2.5 py-0.5 text-[.78rem] font-semibold text-link">New</span> : null}
                  </span>
                  <time dateTime={new Date(alertAt(alert)).toISOString()} className="text-[.9rem] text-ink-muted tabular-nums">
                    {when(alertAt(alert))}
                  </time>
                </span>
                <p className="text-[1rem] leading-relaxed text-ink-muted">
                  {alert.status === "failed" ? runFailureMessage(alert.failureReason) : alert.reason}
                </p>
                {alert.status === "proposed" ? (
                  <div className="flex flex-wrap gap-3 pt-1">
                    <button type="button" disabled={answering !== null} onClick={() => void answer(alert, true)}
                      className="min-h-11 whitespace-nowrap rounded-full bg-accent px-6 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
                      Approve
                    </button>
                    <button type="button" disabled={answering !== null} onClick={() => void answer(alert, false)}
                      className="min-h-11 whitespace-nowrap rounded-full border border-line px-6 font-medium text-ink hover:bg-tint disabled:opacity-60">
                      Not now
                    </button>
                  </div>
                ) : pondGone ? null : (
                  <button type="button" onClick={onOpenPositions}
                    className="min-h-10 self-start whitespace-nowrap font-semibold text-link underline underline-offset-4">
                    See your positions
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
