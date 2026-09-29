import React from "react";
import { ALPHA_POOL, type AlphaWalletSummary } from "@actora/chain";

type Props = {
  summary: AlphaWalletSummary | null;
  onOpenApproveModal: (token: "USDC" | "cirBTC") => void;
};

export const PoolOverviewCard: React.FC<Props> = ({ summary, onOpenApproveModal }) => {
  const pool = summary?.pool;
  const allowances = summary?.allowances;

  const truncate = (addr: string) => `${addr.slice(0, 8)}…${addr.slice(-6)}`;

  // Formatting price ratio
  const usdcPerCirBtc = pool?.token1PerToken0
    ? Number(pool.token1PerToken0).toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "—";

  const managerUsdcAllowance = allowances?.positionManager?.usdc?.formatted ?? "0";
  const managerCirBtcAllowance = allowances?.positionManager?.cirBtc?.formatted ?? "0";

  return (
    <div className="mb-6 rounded-2xl border border-white/10 bg-panel p-6 shadow-xl">
      {/* Pool Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h3 className="text-base font-bold tracking-tight text-slate-100">
              Uniswap v3 cirBTC / USDC
            </h3>
            <span className="inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-400">
              0.01% Fee (Tier 100)
            </span>
            <span className="inline-flex items-center rounded-full border border-white/10 bg-surface px-2.5 py-0.5 text-[11px] font-medium text-slate-300">
              Tick Spacing: 1
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>Contract:</span>
            <a
              href={`https://explorer.arc.io/address/${ALPHA_POOL.address}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-cyan-400 hover:underline"
            >
              {truncate(ALPHA_POOL.address)}
            </a>
          </div>
        </div>

        {/* Live Pool Spot Price */}
        <div className="text-left sm:text-right">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
            Spot Market Price
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-slate-100">
            ${usdcPerCirBtc} <span className="text-sm font-medium text-slate-400">USDC</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Current Tick: <span className="font-mono text-slate-300">{pool?.tick ?? "—"}</span>
          </div>
        </div>
      </div>

      {/* Pool Metrics & Allowances Sub-Grid */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* Metric 1: Active Liquidity */}
        <div className="rounded-xl border border-white/5 bg-surface/60 p-4 transition-colors hover:border-white/10 hover:bg-surface/80">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">ACTIVE LIQUIDITY</span>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
            {pool?.liquidity ? BigInt(pool.liquidity).toLocaleString() : "—"}
          </div>
          <div className="mt-1 text-[11px] text-slate-400 truncate">
            SqrtPriceX96: <span className="font-mono text-slate-300">{pool ? truncate(pool.sqrtPriceX96) : "—"}</span>
          </div>
        </div>

        {/* Metric 2: PositionManager USDC Allowance */}
        <div className="rounded-xl border border-white/5 bg-surface/60 p-4 transition-colors hover:border-white/10 hover:bg-surface/80">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">USDC ALLOWANCE</span>
            <button
              onClick={() => onOpenApproveModal("USDC")}
              className="rounded-lg border border-white/10 bg-surface px-2 py-0.5 text-[11px] font-medium text-slate-300 transition-all hover:bg-surface-hover hover:border-white/20 active:scale-[0.96]"
            >
              Approve
            </button>
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
            {managerUsdcAllowance} <span className="text-xs font-medium text-slate-400">USDC</span>
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            NonfungiblePositionManager
          </div>
        </div>

        {/* Metric 3: PositionManager cirBTC Allowance */}
        <div className="rounded-xl border border-white/5 bg-surface/60 p-4 transition-colors hover:border-white/10 hover:bg-surface/80">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">CIRBTC ALLOWANCE</span>
            <button
              onClick={() => onOpenApproveModal("cirBTC")}
              className="rounded-lg border border-white/10 bg-surface px-2 py-0.5 text-[11px] font-medium text-slate-300 transition-all hover:bg-surface-hover hover:border-white/20 active:scale-[0.96]"
            >
              Approve
            </button>
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-slate-100">
            {managerCirBtcAllowance} <span className="text-xs font-medium text-slate-400">cirBTC</span>
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            NonfungiblePositionManager
          </div>
        </div>
      </div>
    </div>
  );
};
