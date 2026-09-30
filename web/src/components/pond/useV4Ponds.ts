import { useCallback, useEffect, useState } from "react";
import { api, type ManagedWalletRecord, type V4Position } from "../../lib/api-client";

type Notify = (type: "success" | "error" | "info", title: string, message?: string) => void;

/**
 * The wallet's v4 positions and their actions (collect fees, close). One
 * transaction at a time: a pending attempt is remembered for the session, so a
 * reload still waits for it before allowing another.
 */
export function useV4Ponds(wallet: ManagedWalletRecord | null, onRefresh: () => Promise<void>, onNotify: Notify) {
  const [positions, setPositions] = useState<V4Position[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const pendingKey = wallet ? `stillwater-v4-position-attempt:${wallet.id}` : null;
  const [pendingAttempt, setPendingAttempt] = useState<string | null>(null);

  useEffect(() => {
    setPendingAttempt(pendingKey ? sessionStorage.getItem(pendingKey) : null);
  }, [pendingKey]);

  const refresh = useCallback(async () => {
    if (!wallet) { setPositions([]); setNextPage(null); return; }
    setLoading(true);
    try {
      const result = await api.listV4Positions();
      setPositions(result.positions);
      setNextPage(result.hasMore ? 1 : null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your ponds.");
    } finally { setLoading(false); }
  }, [wallet]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = async () => {
    if (nextPage === null) return;
    setLoading(true);
    try {
      const result = await api.listV4Positions(nextPage);
      setPositions((current) => [...current, ...result.positions]);
      setNextPage(result.hasMore ? nextPage + 1 : null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load more ponds.");
    } finally { setLoading(false); }
  };

  const clearPending = () => {
    if (pendingKey) sessionStorage.removeItem(pendingKey);
    setPendingAttempt(null);
  };

  /** Collects fees or closes a position; true once the transaction is confirmed. */
  const run = async (position: V4Position, action: "collect" | "withdraw", options: { quiet?: boolean } = {}) => {
    if (pendingAttempt) {
      onNotify("info", "Still confirming", "Wait for your last step to confirm before starting another.");
      return false;
    }
    setBusy(`${position.tokenId}:${action}`);
    try {
      const prepared = await api.prepareV4PositionAction({ action, tokenId: position.tokenId,
        slippageBps: 100, deadline: String(Math.floor(Date.now() / 1000) + 600),
        idempotencyKey: crypto.randomUUID() });
      const execution = await api.executeIntent(prepared.intentId);
      if (pendingKey) sessionStorage.setItem(pendingKey, execution.attemptId);
      setPendingAttempt(execution.attemptId);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const receipt = await api.reconcileAttempt(execution.attemptId);
        if (receipt.status === "confirmed") {
          clearPending();
          if (!options.quiet) {
            await Promise.all([refresh(), onRefresh()]);
            onNotify("success", action === "collect" ? "Fees collected" : "Pond closed",
              "The tokens are in your Stillwater wallet.");
          }
          return true;
        }
        if (receipt.status !== "pending" && receipt.status !== "submitted") {
          clearPending();
          throw new Error(receipt.reasonCode || "Transaction did not confirm");
        }
      }
      onNotify("info", "Still confirming", "Arc hasn't confirmed this step yet. Stillwater keeps watching it.");
      return false;
    } catch (reason) {
      onNotify("error", "That didn't go through", reason instanceof Error ? reason.message : "Please try again.");
      return false;
    } finally { setBusy(null); }
  };

  const checkPending = async () => {
    if (!pendingAttempt) return;
    try {
      const receipt = await api.reconcileAttempt(pendingAttempt);
      if (receipt.status === "pending" || receipt.status === "submitted") {
        onNotify("info", "Still confirming", "Stillwater is still watching it on Arc.");
        return;
      }
      clearPending();
      await Promise.all([refresh(), onRefresh()]);
      onNotify(receipt.status === "confirmed" ? "success" : "error",
        receipt.status === "confirmed" ? "Confirmed" : "That didn't go through", receipt.reasonCode);
    } catch (reason) {
      onNotify("error", "Could not check your last step", reason instanceof Error ? reason.message : "Please try again.");
    }
  };

  return { positions, nextPage, error, loading, busy, pendingAttempt, refresh, loadMore, run, checkPending };
}
