import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api-client";

export type AttemptOutcome = { ok: true } | { ok: false; message: string };

// Why a transaction did not complete, in words people can act on. Keys are the
// reason codes the reconciler and API return.
const FAILURE_MESSAGES: Record<string, string> = {
  RECEIPT_REVERTED: "Arc rejected it. Only the network fee was spent.",
  TRANSACTION_DROPPED: "It never reached Arc. Nothing moved.",
  TRANSACTION_NOT_FOUND: "It never reached Arc. Nothing moved.",
  NONCE_CONSUMED_BY_UNKNOWN_TRANSACTION: "Another transaction took its place. Wallet paused.",
  TRANSACTION_NONCE_MISMATCH: "Another transaction took its place. Wallet paused.",
  ATTEMPT_NOT_FOUND: "We lost track of it. Check your balances.",
  MAINNET_ATTEMPT_NOT_FOUND: "We lost track of it. Check your balances.",
  UNAUTHENTICATED: "You were signed out. Sign in again.",
};
const FALLBACK_FAILURE = "It didn't go through. Check your balances.";

function attemptFailureMessage(code: string | undefined): string {
  return (code && FAILURE_MESSAGES[code]) || FALLBACK_FAILURE;
}

const FIRST_CHECK_MS = 1_500;
const MAX_CHECK_MS = 15_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { window.clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Waits until Arc settles a sent transaction: resolves once it is confirmed,
 * throws once it failed, reverted or was dropped. There is no time limit; the
 * server's reconciler always reaches a final state (a transaction that never
 * appears is marked dropped). Checks back off to every 15 s.
 */
export async function waitForAttempt(attemptId: string, signal?: AbortSignal): Promise<void> {
  for (let delay = FIRST_CHECK_MS; ; delay = Math.min(delay * 1.5, MAX_CHECK_MS)) {
    await sleep(delay, signal);
    let result;
    try {
      result = await api.reconcileAttempt(attemptId);
    } catch (error) {
      // Network errors, rate limits and server errors say nothing about the transaction: check again.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw new Error(attemptFailureMessage(error.code));
      }
      continue;
    }
    if (result.status === "confirmed") return;
    if (result.status !== "pending" && result.status !== "submitted") {
      throw new Error(attemptFailureMessage(result.reasonCode));
    }
  }
}

/**
 * One transaction at a time per `key`. `track` waits for a new attempt; an
 * attempt still unsettled when the page was left is picked up again on return
 * and reported through `onResumed`.
 */
export function usePendingAttempt(key: string | null, onResumed: (outcome: AttemptOutcome) => void) {
  const [pending, setPending] = useState<string | null>(null);
  const onResumedRef = useRef(onResumed);
  onResumedRef.current = onResumed;

  useEffect(() => {
    const stored = key ? sessionStorage.getItem(key) : null;
    setPending(stored);
    if (!key || !stored) return;
    const controller = new AbortController();
    waitForAttempt(stored, controller.signal)
      .then((): AttemptOutcome => ({ ok: true }))
      .catch((error: unknown): AttemptOutcome => ({
        ok: false, message: error instanceof Error ? error.message : FALLBACK_FAILURE,
      }))
      .then((outcome) => {
        if (controller.signal.aborted) return;
        sessionStorage.removeItem(key);
        setPending(null);
        onResumedRef.current(outcome);
      });
    return () => controller.abort();
  }, [key]);

  const track = async (attemptId: string) => {
    if (key) sessionStorage.setItem(key, attemptId);
    setPending(attemptId);
    try {
      await waitForAttempt(attemptId);
    } finally {
      if (key) sessionStorage.removeItem(key);
      setPending(null);
    }
  };

  return { pending, track };
}
