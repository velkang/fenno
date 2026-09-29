import React, { useEffect, useState } from "react";
import type { AlphaWalletSummary } from "@stillwater/chain";
import { zeroAddress } from "viem";
import { api, type ManagedWalletRecord, type V4Position } from "../lib/api-client";
import { tickToPrice as tickToPairPrice } from "../lib/range-math";
import { formatPoolPrice, poolSpotPrice } from "./ExplorePage";
import type { ModalType } from "../components/IntentActionModal";
import {
  IconCheck,
  IconAlert,
  IconPlus,
  IconDeposit,
  IconChevronDown,
  IconChevronUp,
} from "../components/Icons";

type Props = {
  summary: AlphaWalletSummary | null;
  wallet: ManagedWalletRecord | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
  onOpenModal: (modal: ModalType) => void;
  onNavigateDeposit: () => void;
};

function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick) * 100;
}

// Dollar price of the listed token at each end of a v4 position, whichever side USDC is on.
function v4RangePrices(position: V4Position): { min: number; max: number } {
  const { pool } = position;
  const usdcDecimals = [pool.token0, pool.token1].some((address) => address.toLowerCase() === zeroAddress) ? 18 : 6;
  if (pool.token0.toLowerCase() === pool.token.address.toLowerCase()) {
    return { min: tickToPairPrice(position.tickLower, pool.token.decimals, usdcDecimals),
      max: tickToPairPrice(position.tickUpper, pool.token.decimals, usdcDecimals) };
  }
  return { min: 1 / tickToPairPrice(position.tickUpper, usdcDecimals, pool.token.decimals),
    max: 1 / tickToPairPrice(position.tickLower, usdcDecimals, pool.token.decimals) };
}

// The first block on the page is a plain section header rather than a card.
const FIRST_SECTION = "rounded-none border-0 border-b border-[#263243] bg-transparent px-0 pt-0 pb-[18px] shadow-none";

export const PositionsPage: React.FC<Props> = ({
  summary,
  wallet,
  onRefresh,
  onNotify,
  onOpenModal,
  onNavigateDeposit,
}) => {
  const positions = summary?.positions ?? [];
  const currentTick = summary?.pool?.tick;
  const poolPrice = summary?.pool?.token1PerToken0 ? Number(summary.pool.token1PerToken0) : null;
  const spotPrice = poolPrice ?? (currentTick !== undefined ? tickToPrice(currentTick) : 64280.50);

  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const [v4Positions, setV4Positions] = useState<V4Position[]>([]);
  const [v4NextPage, setV4NextPage] = useState<number | null>(null);
  const [v4Error, setV4Error] = useState<string | null>(null);
  const [v4Loading, setV4Loading] = useState(false);
  const [v4Action, setV4Action] = useState<string | null>(null);
  const pendingKey = wallet ? `stillwater-v4-position-attempt:${wallet.id}` : null;
  const [pendingAttempt, setPendingAttempt] = useState<string | null>(null);

  useEffect(() => {
    setPendingAttempt(pendingKey ? sessionStorage.getItem(pendingKey) : null);
  }, [pendingKey]);

  const refreshV4 = async () => {
    if (!wallet) { setV4Positions([]); setV4NextPage(null); return; }
    setV4Loading(true);
    try {
      const result = await api.listV4Positions();
      setV4Positions(result.positions);
      setV4NextPage(result.hasMore ? 1 : null);
      setV4Error(null);
    } catch (error) {
      setV4Error(error instanceof Error ? error.message : "Could not load your positions.");
    } finally { setV4Loading(false); }
  };

  const loadMoreV4 = async () => {
    if (v4NextPage === null) return;
    setV4Loading(true);
    try {
      const result = await api.listV4Positions(v4NextPage);
      setV4Positions((current) => [...current, ...result.positions]);
      setV4NextPage(result.hasMore ? v4NextPage + 1 : null);
      setV4Error(null);
    } catch (error) {
      setV4Error(error instanceof Error ? error.message : "Could not load more positions.");
    } finally { setV4Loading(false); }
  };

  useEffect(() => {
    void refreshV4();
  }, [wallet?.id]);

  const runV4Action = async (position: V4Position, action: "collect" | "withdraw") => {
    if (pendingAttempt) {
      onNotify("info", "Still confirming", "Wait for your last transaction to confirm before trying another action.");
      return;
    }
    if (action === "withdraw" && !window.confirm(
      `Close your ${position.pool.token.symbol} / USDC position #${position.tokenId}? Both tokens and any fees you've earned go back to your Stillwater wallet.`,
    )) return;
    setV4Action(`${position.tokenId}:${action}`);
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
          if (pendingKey) sessionStorage.removeItem(pendingKey);
          setPendingAttempt(null);
          await Promise.all([refreshV4(), onRefresh()]);
          onNotify("success", action === "collect" ? "Fees collected" : "Position closed",
            "The tokens are in your Stillwater wallet.");
          return;
        }
        if (receipt.status !== "pending" && receipt.status !== "submitted") {
          if (pendingKey) sessionStorage.removeItem(pendingKey);
          setPendingAttempt(null);
          throw new Error(receipt.reasonCode || "Transaction did not confirm");
        }
      }
      onNotify("info", "Transaction pending", "Stillwater is still tracking this transaction on Arc.");
    } catch (error) {
      onNotify("error", "That didn't go through", error instanceof Error ? error.message : "Please retry.");
    } finally { setV4Action(null); }
  };

  const checkPendingV4 = async () => {
    if (!pendingAttempt) return;
    try {
      const receipt = await api.reconcileAttempt(pendingAttempt);
      if (receipt.status === "pending" || receipt.status === "submitted") {
        onNotify("info", "Transaction pending", "Stillwater is still tracking it on Arc.");
        return;
      }
      if (pendingKey) sessionStorage.removeItem(pendingKey);
      setPendingAttempt(null);
      await Promise.all([refreshV4(), onRefresh()]);
      onNotify(receipt.status === "confirmed" ? "success" : "error",
        receipt.status === "confirmed" ? "Transaction confirmed" : "Transaction failed",
        receipt.reasonCode);
    } catch (error) {
      onNotify("error", "Could not check transaction",
        error instanceof Error ? error.message : "Please retry.");
    }
  };

  const toggleDetails = (tokenId: string) => {
    setExpandedDetails((prev) => ({ ...prev, [tokenId]: !prev[tokenId] }));
  };

  return (
    <div className="mx-auto w-[min(100%,1586px)] space-y-6 text-[0.9375rem] leading-normal text-[#f3f4f6] [-webkit-tap-highlight-color:transparent] max-[680px]:text-[.875rem] [&_:is(button,a):focus-visible]:outline-2 [&_:is(button,a):focus-visible]:outline-offset-3 [&_:is(button,a):focus-visible]:outline-[#6ee7b7]">
      {/* Positions Header */}
      <div className={FIRST_SECTION}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight text-[#e7edf5]">
                Your positions
              </h1>
              <span className="inline-flex items-center rounded-full border border-[#145c47] bg-[#092820] px-2.5 py-0.5 text-xs font-semibold text-[#6ee7b7]">
                {positions.length + v4Positions.length} {positions.length + v4Positions.length === 1 ? "Position" : "Positions"}
              </span>
            </div>
            <p className="mt-1 text-xs text-[#aab6c8]">
              Each position earns a share of trading fees while the token price stays inside its range.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {pendingAttempt && <button type="button" onClick={() => void checkPendingV4()}
              className="px-2 text-xs font-semibold text-[#fcd34d]">Check last transaction</button>}
            {wallet && <button type="button" onClick={() => void refreshV4()} disabled={v4Loading}
              className="px-2 text-xs font-semibold text-[#6ee7b7] disabled:opacity-50">Refresh</button>}
            <button
              type="button"
              onClick={() => onOpenModal({ type: "import" })}
              className="rounded-lg border border-[#29364a] bg-[#111827] px-3.5 py-2 text-xs font-semibold text-[#e7edf5] hover:bg-[#1a2635] active:scale-95 shadow-sm"
            >
              Add a position you already own
            </button>
            <button
              type="button"
              onClick={onNavigateDeposit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#059669] px-4 py-2 text-xs font-semibold text-white hover:bg-[#047857] active:scale-95 shadow-sm"
            >
              <IconPlus size={14} /> Open New Position
            </button>
          </div>
        </div>
      </div>

      {v4Loading && <p className="text-sm text-[#aab6c8]" role="status">Loading positions…</p>}
      {v4Error && <p className="text-sm text-[#fda4af]" role="alert">{v4Error}</p>}

      {/* Empty State */}
      {positions.length === 0 && v4Positions.length === 0 ? v4Loading || v4Error ? null : (
        <div className="rounded-xl border border-dashed border-[#29364a] bg-[#111827] p-12 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#145c47] bg-[#092820] text-[#6ee7b7] mb-4">
            <IconDeposit size={26} />
          </div>
          <h3 className="text-base font-bold text-[#e7edf5] mb-1">
            No positions yet
          </h3>
          <p className="mx-auto max-w-md text-xs text-[#aab6c8] leading-relaxed mb-6">
            Add a token and USDC to a pool to start earning a share of the fees traders pay. Your position shows up here, and you can collect fees or close it at any time.
          </p>
          <button
            type="button"
            onClick={onNavigateDeposit}
            className="inline-flex items-center gap-2 rounded-lg bg-[#059669] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#047857] active:scale-95 shadow-sm"
          >
            <IconPlus size={14} /> Create Your First Position
          </button>
        </div>
      ) : (
        /* Position List */
        <div className="space-y-4">
          {v4Positions.map((position) => {
            const inRange = position.pool.tick >= position.tickLower &&
              position.pool.tick < position.tickUpper;
            const range = v4RangePrices(position);
            const price = poolSpotPrice(position.pool);
            const symbol = position.pool.token.symbol;
            return <article key={position.tokenId} className="rounded-xl border border-[#29364a] bg-[#111827] p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-[#e7edf5]">{symbol} / USDC <span className="font-normal text-[#aab6c8]">· Position #{position.tokenId}</span></h3>
                  <p className={`mt-1 text-sm ${inRange ? "text-[#6ee7b7]" : "text-[#fcd34d]"}`}>
                    {inRange ? "Earning fees" : "Paused: the price is outside your range"}</p>
                  <p className="mt-1 text-sm text-[#aab6c8]">Earns while {symbol} is between ${formatPoolPrice(range.min)} and ${formatPoolPrice(range.max)} · now ${formatPoolPrice(price)}</p>
                  {!inRange ? <p className="mt-1 text-xs text-[#aab6c8]">{price < range.min
                    ? `It currently holds only ${symbol}. It starts earning again if the price rises above $${formatPoolPrice(range.min)}.`
                    : `It currently holds only USDC. It starts earning again if the price falls below $${formatPoolPrice(range.max)}.`}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={v4Action !== null || pendingAttempt !== null}
                    onClick={() => void runV4Action(position, "collect")}
                    className="rounded-lg bg-[#059669] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#047857] active:scale-95 disabled:opacity-50">Collect fees</button>
                  <button type="button" disabled={v4Action !== null || pendingAttempt !== null}
                    onClick={() => void runV4Action(position, "withdraw")}
                    className="rounded-lg border border-[#71303d] bg-[#2d171d] px-3 py-1.5 text-xs font-semibold text-[#fda4af] hover:bg-[#4b1c28] active:scale-95 disabled:opacity-50">Close position</button>
                </div>
              </div>
            </article>;
          })}
          {positions.map((pos) => {
            const minP = tickToPrice(pos.tickLower);
            const maxP = tickToPrice(pos.tickUpper);
            const inRange =
              currentTick !== undefined
                ? currentTick >= pos.tickLower && currentTick <= pos.tickUpper
                : false;
            const isAboveCeiling = currentTick !== undefined && currentTick > pos.tickUpper;

            // Gauge cursor percentage
            const gaugeRatio = maxP > minP ? (spotPrice - minP) / (maxP - minP) : 0.5;
            const gaugePercent = Math.max(3, Math.min(97, gaugeRatio * 100));

            const isDetailsOpen = expandedDetails[pos.tokenId] ?? false;

            return (
              <div
                key={pos.tokenId}
                className="rounded-xl border border-[#29364a] bg-[#111827] p-6 space-y-5"
              >
                {/* Card Header: NFT ID, Pair, and Status Badge */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#29364a] pb-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#29364a] bg-[#151e2b] font-mono text-xs font-bold text-[#e7edf5]">
                      #{pos.tokenId}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-[#e7edf5]">cirBTC / USDC</h3>
                        <span className="rounded border border-[#29364a] bg-[#151e2b] px-2 py-0.5 text-[10px] font-semibold text-[#aab6c8]">
                          0.01% fee
                        </span>
                      </div>
                      <p className="font-mono text-xs text-[#aab6c8]">
                        Earning range: ${minP.toLocaleString("en-US", { maximumFractionDigits: 0 })} – ${maxP.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </p>
                    </div>
                  </div>

                  <div>
                    {inRange ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#145c47] bg-[#092820] px-3 py-1 text-xs font-semibold text-[#6ee7b7]">
                        <IconCheck size={14} /> Earning fees
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#74531c] bg-[#2c2110] px-3 py-1 text-xs font-semibold text-[#fcd34d]">
                        <IconAlert size={14} /> Paused: price outside range
                      </span>
                    )}
                  </div>
                </div>

                {/* Visual Mini Range Track */}
                <div className="rounded-xl border border-[#29364a] bg-[#151e2b] p-4">
                  <div className="flex items-center justify-between text-xs text-[#aab6c8] mb-2">
                    <span className="font-medium">Stops below ${minP.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                    <span className="font-mono font-bold text-[#e7edf5]">
                      Price now: ${spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                    </span>
                    <span className="font-medium">Stops above ${maxP.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                  </div>

                  <div className="relative h-2.5 w-full rounded-full bg-[#202c3c] overflow-hidden">
                    {/* In-range band */}
                    <div className="absolute inset-0 bg-[#059669]" />
                    {/* Spot Cursor Marker */}
                    <div
                      className="absolute top-0 bottom-0 w-2.5 -ml-1 rounded-full bg-[#f59e0b] shadow-sm"
                      style={{ left: `${gaugePercent}%` }}
                    />
                  </div>
                </div>

                {/* Plain-English Status Explainer Box */}
                <div
                  className={`rounded-xl border p-4 text-xs leading-relaxed ${
                    inRange
                      ? "border-[#145c47] bg-[#092820] text-[#6ee7b7]"
                      : "border-[#74531c] bg-[#2c2110] text-[#fcd34d]"
                  }`}
                >
                  {inRange ? (
                    <p>
                      <strong>Earning fees.</strong> The price is inside your range, so this position earns a share of every trade in this pool.
                    </p>
                  ) : isAboveCeiling ? (
                    <p>
                      <strong>Paused: the price is above your range.</strong> cirBTC is at ${spotPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}, above your ${maxP.toLocaleString("en-US", { maximumFractionDigits: 0 })} limit, so this position now holds <strong>only USDC</strong>. Fees you've already earned are still there. It starts earning again if the price falls back below ${maxP.toLocaleString("en-US", { maximumFractionDigits: 0 })}.
                    </p>
                  ) : (
                    <p>
                      <strong>Paused: the price is below your range.</strong> cirBTC is at ${spotPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}, below your ${minP.toLocaleString("en-US", { maximumFractionDigits: 0 })} limit, so this position now holds <strong>only cirBTC</strong>. Fees you've already earned are still there. It starts earning again if the price rises back above ${minP.toLocaleString("en-US", { maximumFractionDigits: 0 })}.
                    </p>
                  )}
                </div>

                {/* Metrics Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

                  <div className="border-0 border-t border-[#29364a] p-3.5">
                    <span className="text-[10px] font-bold text-[#aab6c8] uppercase tracking-wider">
                      Fees earned in cirBTC
                    </span>
                    <div className="mt-1 font-mono text-base font-bold text-[#6ee7b7]">
                      {pos.claimable0.formatted} <span className="text-xs text-[#aab6c8] font-normal">cirBTC</span>
                    </div>
                    <span className="text-[11px] text-[#aab6c8]">Ready to collect</span>
                  </div>

                  <div className="border-0 border-t border-[#29364a] p-3.5">
                    <span className="text-[10px] font-bold text-[#aab6c8] uppercase tracking-wider">
                      Fees earned in USDC
                    </span>
                    <div className="mt-1 font-mono text-base font-bold text-[#6ee7b7]">
                      {pos.claimable1.formatted} <span className="text-xs text-[#aab6c8] font-normal">USDC</span>
                    </div>
                    <span className="text-[11px] text-[#aab6c8]">Ready to collect</span>
                  </div>
                </div>

                {/* Actions Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#29364a] pt-4">
                  <button
                    type="button"
                    onClick={() => toggleDetails(pos.tokenId)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#aab6c8] hover:text-[#f3f4f6]"
                  >
                    <span>Technical details</span>
                    {isDetailsOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                  </button>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenModal({ type: "action", kind: "collect", position: pos })}
                      className="rounded-lg bg-[#059669] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#047857] active:scale-95 shadow-sm"
                    >
                      Collect fees
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenModal({ type: "action", kind: "increase", position: pos })}
                      className="rounded-lg border border-[#29364a] bg-[#111827] px-3 py-1.5 text-xs font-semibold text-[#e7edf5] hover:bg-[#1a2635] active:scale-95 shadow-sm"
                    >
                      Add more
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenModal({ type: "action", kind: "decrease", position: pos })}
                      className="rounded-lg border border-[#29364a] bg-[#111827] px-3 py-1.5 text-xs font-semibold text-[#e7edf5] hover:bg-[#1a2635] active:scale-95 shadow-sm"
                    >
                      Remove some
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenModal({ type: "action", kind: "withdraw", position: pos })}
                      className="rounded-lg border border-[#71303d] bg-[#2d171d] px-3 py-1.5 text-xs font-semibold text-[#fda4af] hover:bg-[#4b1c28] active:scale-95 shadow-sm"
                      title="Take everything out of this position and close it"
                    >
                      Close position
                    </button>
                  </div>
                </div>

                {/* Pro Details Accordion */}
                {isDetailsOpen ? (
                  <div className="rounded-xl border border-[#29364a] bg-[#151e2b] p-4 text-xs font-mono text-[#aab6c8] grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div>Lower Tick: <span className="font-bold text-[#e7edf5]">{pos.tickLower}</span></div>
                    <div>Upper Tick: <span className="font-bold text-[#e7edf5]">{pos.tickUpper}</span></div>
                    <div>Liquidity: <span className="font-bold text-[#e7edf5]">{BigInt(pos.liquidity).toLocaleString()}</span></div>
                    <div>Position NFT: <span className="font-bold text-[#e7edf5]">#{pos.tokenId}</span></div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {v4NextPage !== null && <button type="button" onClick={() => void loadMoreV4()}
            disabled={v4Loading} className="text-sm text-[#6ee7b7] disabled:opacity-50">Load more positions</button>}
        </div>
      )}
    </div>
  );
};
