import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AutomationAlert, type AutomationRun, type ManagedWalletRecord, type Mandate } from "./api-client";

// Re-centring runs: what's going on, and what to tell people when one ends.

const POLL_MS = 5_000;
// Tomo looks every 5 minutes, so alerts are checked as often, and only while the tab is visible.
const ALERTS_POLL_MS = 5 * 60_000;

// Why a run stopped, in words people can act on. Everything else gets the fallback.
const RUN_FAILURES: Record<string, string> = {
  RECEIPT_REVERTED: "Arc rejected one of its steps.",
  TRANSACTION_DROPPED: "One of its steps never reached Arc.",
  RUN_TIMED_OUT: "It took too long.",
  NOTHING_TO_REOPEN: "There was too little left to open a new band.",
  INSUFFICIENT_USDC_AFTER_FEES: "There wasn't enough USDC left for the network fees.",
  MANDATE_NOT_ACTIVE: "Its permission was turned off.",
  MANDATE_VALUE_EXCEEDS_LIMIT: "The new band would have been bigger than allowed.",
  V4_MINT_SIMULATION_FAILED: "The pool wouldn't take the new band.",
  V4_POOL_NOT_EXECUTABLE: "The pool couldn't swap right now.",
  PRICE_IMPACT_TOO_HIGH: "The pool was too thin to swap without losing more than 5%.",
  POOL_TOO_THIN: "The pool holds almost nothing, so opening a band there wasn't safe.",
  AUTOMATION_UNAVAILABLE: "Re-centring isn't available right now.",
  AUTOMATION_NOT_CONFIGURED: "Re-centring isn't set up yet.",
  // Reasons a re-centre can't start.
  RUN_IN_PROGRESS: "A re-centre is already going for this wallet.",
  MANDATE_LIMIT_TOO_LOW: "Your permission for this pool allows less than this band holds.",
  MANDATE_DAILY_LIMIT_REACHED: "This pool has been re-centred as often as allowed today.",
  WALLET_NOT_ACTIVE: "Your wallet is paused.",
  POSITION_TOO_SMALL: "This band holds less than the network fees would cost.",
  RUN_EXPIRED: "That suggestion has lapsed.",
  RUN_NOT_PROPOSED: "That suggestion has already been answered.",
  RUN_LOST: "Fenno lost track of it partway.",
};

export function runFailureMessage(code: string | null): string {
  return (code && RUN_FAILURES[code]) || "One of its steps didn't go through.";
}

/**
 * The wallet's recent runs, checked every few seconds while one is going. `onFinished`
 * hears about each run that ends while the page is open.
 */
export function useAutomationRuns(wallet: ManagedWalletRecord | null, onFinished?: (run: AutomationRun) => void) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const previous = useRef<Map<string, AutomationRun["status"]>>(new Map());
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const refresh = useCallback(async () => {
    if (!wallet) { setRuns([]); return; }
    try {
      const { runs: latest } = await api.listAutomationRuns();
      for (const run of latest) {
        if (previous.current.get(run.id) === "running" && run.status !== "running") onFinishedRef.current?.(run);
      }
      previous.current = new Map(latest.map((run) => [run.id, run.status]));
      setRuns(latest);
    } catch {
      // Runs are extra information; the page works without them and the next check retries.
    }
  }, [wallet]);

  useEffect(() => { void refresh(); }, [refresh]);
  const running = runs.some((run) => run.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  return { runs, refresh };
}

/** The wallet's mandates: which ponds Tomo looks after, and how. */
export function useMandates(wallet: ManagedWalletRecord | null) {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const refresh = useCallback(async () => {
    if (!wallet) { setMandates([]); return; }
    try {
      setMandates((await api.listMandates()).mandates);
    } catch {
      // Without them the ponds still show; the setting just isn't marked.
    }
  }, [wallet]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { mandates, refresh };
}

/** When an alert last changed: when its run ended, else started, else was suggested. */
export const alertAt = (alert: AutomationRun) => alert.finishedAt ?? alert.startedAt ?? alert.createdAt;

/** Tomo's alerts for the wallet, and whether any arrived since the user last opened them (on any device). */
export function useAlerts(wallet: ManagedWalletRecord | null) {
  const [alerts, setAlerts] = useState<AutomationAlert[]>([]);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The wallet record is replaced on every wallet poll; only a different wallet means a new check.
  const walletId = wallet?.id;

  const refresh = useCallback(async () => {
    if (!walletId) { setAlerts([]); setSeenAt(null); setLoaded(false); return; }
    try {
      const latest = await api.listAlerts();
      setAlerts(latest.alerts);
      setSeenAt(latest.seenAt);
      setLoaded(true);
    } catch {
      // Alerts are extra information; the next check retries.
    }
  }, [walletId]);

  useEffect(() => {
    void refresh();
    const refreshIfVisible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(refreshIfVisible, ALERTS_POLL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);

  const markSeen = useCallback(async () => {
    try {
      setSeenAt((await api.markAlertsSeen()).seenAt);
    } catch {
      // The dot stays until the next visit marks them seen.
    }
  }, []);

  const unread = alerts.some((alert) => alertAt(alert) > (seenAt ?? 0));
  return { alerts, seenAt, loaded, unread, refresh, markSeen };
}
