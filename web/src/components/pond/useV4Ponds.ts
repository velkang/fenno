import { useCallback, useEffect, useState } from "react";
import { api, type ManagedWalletRecord, type V4Position } from "../../lib/api-client";
import { usePendingAttempt } from "../../lib/attempts";

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
  // Start as loading when there is a wallet, so the page never flashes "no positions" first.
  const [loading, setLoading] = useState(wallet !== null);
  const [busy, setBusy] = useState<string | null>(null);

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

  // A step still confirming when the page was left is picked up again here.
  const { pending: pendingAttempt, track } = usePendingAttempt(
    wallet ? `stillwater-v4-position-attempt:${wallet.id}` : null,
    (outcome) => {
      if (outcome.ok) onNotify("success", "Confirmed");
      else onNotify("error", "Failed", outcome.message);
      void Promise.all([refresh(), onRefresh()]);
    },
  );

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

  /** Collects fees or closes a position; true once the transaction is confirmed. */
  const run = async (position: V4Position, action: "collect" | "withdraw", options: { quiet?: boolean } = {}) => {
    if (pendingAttempt) {
      onNotify("info", "Still confirming", "Wait for your last step to finish.");
      return false;
    }
    setBusy(`${position.tokenId}:${action}`);
    try {
      const prepared = await api.prepareV4PositionAction({ action, tokenId: position.tokenId,
        slippageBps: 100, deadline: String(Math.floor(Date.now() / 1000) + 600),
        idempotencyKey: crypto.randomUUID() });
      const execution = await api.executeIntent(prepared.intentId);
      await track(execution.attemptId);
      if (!options.quiet) {
        await Promise.all([refresh(), onRefresh()]);
        onNotify("success", action === "collect" ? "Fees collected" : "Pond closed",
          "Tokens are in your wallet.");
      }
      return true;
    } catch (reason) {
      onNotify("error", "Failed", reason instanceof Error ? reason.message : "Please try again.");
      // A failed step can still have cost a network fee: show current balances now.
      void Promise.all([refresh(), onRefresh()]);
      return false;
    } finally { setBusy(null); }
  };

  return { positions, nextPage, error, loading, busy, pendingAttempt, refresh, loadMore, run };
}
