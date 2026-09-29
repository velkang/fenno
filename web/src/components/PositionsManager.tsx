import React from "react";
import type { AlphaWalletSummary } from "@stillwater/chain";
import type { ModalType } from "./IntentActionModal";

type Props = {
  summary: AlphaWalletSummary | null;
  onOpenModal: (modal: ModalType) => void;
};

export const PositionsManager: React.FC<Props> = ({ summary, onOpenModal }) => {
  const positions = summary?.positions ?? [];
  const currentTick = summary?.pool?.tick;

  return (
    <div className="mb-6 rounded-2xl border border-white/10 bg-panel p-6 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h3 className="text-base font-bold tracking-tight text-slate-100">Managed Liquidity Positions</h3>
            <span className="inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-400">
              {positions.length} Active
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Uniswap v3 ERC-721 positions owned and managed by your Stillwater EOA.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenModal({ type: "import" })}
            className="inline-flex items-center rounded-xl border border-white/10 bg-surface px-3 py-1.5 text-xs font-medium text-slate-200 transition-all hover:bg-surface-hover hover:border-white/20 active:scale-[0.96]"
          >
            Import Position NFT
          </button>
          <button
            onClick={() => onOpenModal({ type: "mint" })}
            className="inline-flex items-center rounded-xl bg-emerald-primary px-3.5 py-1.5 text-xs font-semibold text-emerald-950 shadow-md transition-all hover:bg-emerald-hover active:scale-[0.96]"
          >
            + Mint New Position
          </button>
        </div>
      </div>

      {/* Position List or Empty State */}
      {positions.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-surface/30 p-10 text-center">
          <div className="text-sm font-semibold text-slate-200 mb-1">
            No Active Positions Found
          </div>
          <p className="mx-auto mb-5 max-w-sm text-xs text-slate-400 leading-relaxed">
            This managed wallet does not currently hold any Uniswap v3 positions in the allowlisted cirBTC/USDC pool.
          </p>
          <button
            onClick={() => onOpenModal({ type: "mint" })}
            className="inline-flex items-center rounded-xl bg-emerald-primary px-4 py-2 text-xs font-semibold text-emerald-950 shadow-md transition-all hover:bg-emerald-hover active:scale-[0.96]"
          >
            Open Your First Position
          </button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3.5">
          {positions.map((pos) => {
            const inRange =
              currentTick !== undefined
                ? currentTick >= pos.tickLower && currentTick <= pos.tickUpper
                : false;

            return (
              <div
                key={pos.tokenId}
                className="rounded-xl border border-white/5 bg-surface/60 p-4 transition-colors hover:border-white/10 hover:bg-surface/80 flex flex-col gap-3"
              >
                {/* Top Row: Token ID, Range Status */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-base font-bold tabular-nums text-slate-100">
                      NFT #{pos.tokenId}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${
                        inRange
                          ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : "border border-amber-500/30 bg-amber-500/10 text-amber-400"
                      }`}
                    >
                      {inRange ? "In Range (Active)" : "Out of Range"}
                    </span>
                  </div>

                  <div className="font-mono text-xs text-slate-400 tabular-nums">
                    Ticks: [{pos.tickLower}, {pos.tickUpper}]
                  </div>
                </div>

                {/* Metrics Row: Liquidity & Claimable Fees */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-white/5 pt-3">
                  <div>
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">LIQUIDITY</span>
                    <div className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-100">
                      {BigInt(pos.liquidity).toLocaleString()}
                    </div>
                  </div>

                  <div>
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                      CLAIMABLE cirBTC FEES
                    </span>
                    <div className="mt-0.5 font-mono text-sm font-bold tabular-nums text-emerald-400">
                      {pos.claimable0.formatted} <span className="text-xs font-normal text-slate-400">cirBTC</span>
                    </div>
                  </div>

                  <div>
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                      CLAIMABLE USDC FEES
                    </span>
                    <div className="mt-0.5 font-mono text-sm font-bold tabular-nums text-emerald-400">
                      {pos.claimable1.formatted} <span className="text-xs font-normal text-slate-400">USDC</span>
                    </div>
                  </div>
                </div>

                {/* Actions Row */}
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/5 pt-3">
                  <button
                    onClick={() => onOpenModal({ type: "action", kind: "collect", position: pos })}
                    className="rounded-lg border border-white/10 bg-surface px-2.5 py-1 text-xs font-medium text-slate-300 transition-all hover:bg-surface-hover hover:border-white/20 active:scale-[0.96]"
                  >
                    Collect Fees
                  </button>
                  <button
                    onClick={() => onOpenModal({ type: "action", kind: "increase", position: pos })}
                    className="rounded-lg border border-white/10 bg-surface px-2.5 py-1 text-xs font-medium text-slate-300 transition-all hover:bg-surface-hover hover:border-white/20 active:scale-[0.96]"
                  >
                    + Increase
                  </button>
                  <button
                    onClick={() => onOpenModal({ type: "action", kind: "decrease", position: pos })}
                    className="rounded-lg border border-white/10 bg-surface px-2.5 py-1 text-xs font-medium text-slate-300 transition-all hover:bg-surface-hover hover:border-white/20 active:scale-[0.96]"
                  >
                    - Decrease
                  </button>
                  <button
                    onClick={() => onOpenModal({ type: "action", kind: "withdraw", position: pos })}
                    className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-400 transition-all hover:bg-rose-500/20 active:scale-[0.96]"
                    title="Atomic 3-part withdrawal: decrease, collect all, and burn NFT"
                  >
                    Atomic Full Withdrawal
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
