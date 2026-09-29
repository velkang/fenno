import React from "react";
import { useAccount, useChainId } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { ARC_CHAIN_ID } from "@stillwater/chain";
import type { AuthUser } from "../lib/api-client";
import {
  IconPositions,
  IconWallet,
  IconSearch,
  IconArrowLeftRight,
} from "./Icons";

export type PageRoute = "explore" | "pool" | "positions" | "swap";

type Props = {
  user: AuthUser | null;
  activePage: PageRoute;
  onNavigate: (page: PageRoute) => void;
  activePositionsCount?: number;
  onLogout: () => void;
  onOpenAuthModal?: () => void;
  onOpenWallet: () => void;
  walletOpen?: boolean;
};

export const Header: React.FC<Props> = ({
  user,
  activePage,
  onNavigate,
  activePositionsCount = 0,
  onLogout,
  onOpenAuthModal,
  onOpenWallet,
  walletOpen = false,
}) => {
  const { open } = useAppKit();
  const { isConnected } = useAccount();
  const chainId = useChainId();

  const isArcMainnet = !isConnected || chainId === ARC_CHAIN_ID;

  const navItems: { key: PageRoute; label: string; shortLabel: string; icon: React.FC<{ size?: number; className?: string }> }[] = [
    { key: "explore", label: "Explore", shortLabel: "Explore", icon: IconSearch },
    { key: "positions", label: "Positions", shortLabel: "Positions", icon: IconPositions },
    { key: "swap", label: "Swap", shortLabel: "Swap", icon: IconArrowLeftRight },
  ];

  return (
    <header className="sticky top-0 z-50 min-h-[70px] border-b border-[#263243] bg-[#0b0f19] px-[clamp(18px,3.2vw,52px)] py-0 text-[#f3f4f6] [-webkit-tap-highlight-color:transparent] max-[680px]:px-4 motion-reduce:[&_*]:!transition-none [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-3 [&_button:focus-visible]:outline-[#6ee7b7]">
      <div className="mx-auto flex min-h-[70px] max-w-[1586px] flex-wrap items-center justify-between gap-2 lg:gap-4 max-[680px]:grid max-[680px]:min-h-auto max-[680px]:grid-cols-[minmax(0,1fr)_auto] max-[680px]:gap-x-2 max-[680px]:gap-y-0 max-[680px]:pt-[7px] max-[680px]:pb-0">
        <div className="flex min-w-0 items-center gap-2 lg:gap-6 max-[680px]:contents">
          {/* Brand */}
          <button
            type="button"
            aria-label="Stillwater home"
          onClick={() => onNavigate("explore")}
            className="flex min-h-11 shrink-0 items-center gap-0 rounded-lg focus-visible:ring-2 focus-visible:ring-blue-600 max-[680px]:col-start-1 max-[680px]:row-start-1"
          >
            <span className="text-[1.5rem] leading-[1.5] font-[750] tracking-[.105em] text-[#f3f4f6] uppercase max-[680px]:text-[1.2rem]">
              Stillwater
            </span>
          </button>

          {/* Primary Page Navigation (Always Visible) */}
          <nav aria-label="Main navigation" className="ml-[clamp(20px,3.6vw,58px)] flex shrink-0 items-center gap-[22px] self-stretch max-[680px]:col-span-full max-[680px]:row-start-2 max-[680px]:m-0 max-[680px]:justify-between max-[680px]:gap-2.5">
            {navItems.map((item) => {
              const isActive = activePage === item.key || (activePage === "pool" && item.key === "explore");
              const IconComponent = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onNavigate(item.key)}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  title={item.label}
                  className={`relative inline-flex min-h-[70px] min-w-0 flex-col items-center justify-center gap-0.5 px-1 py-0 text-[.9rem] leading-[calc(1/0.75)] font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96] lg:flex-row lg:gap-2 max-[680px]:min-h-[46px] max-[680px]:flex-1 max-[680px]:flex-row max-[680px]:gap-1.5 max-[680px]:text-[.77rem] ${
                    isActive
                      ? "text-[#10b981] after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-[#10b981]"
                      : "text-[#b6c1d1] hover:text-[#f3f4f6]"
                  }`}
                >
                  <IconComponent size={15} />
                  <span className="leading-none lg:hidden">{item.shortLabel}</span>
                  <span className="hidden whitespace-nowrap lg:inline">{item.label}</span>
                  {item.key === "positions" && activePositionsCount > 0 ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                      {activePositionsCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right: Network & Wallet Controls */}
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5 min-[681px]:gap-2.5 max-[680px]:col-start-2 max-[680px]:row-start-1 max-[680px]:flex-nowrap">
          {/* Network Selector */}
          <button
            onClick={() => open({ view: "Networks" })}
            className="hidden min-h-[42px] items-center gap-2 rounded-[10px] border border-[#344256] bg-[#151e2b] text-[#e7edf5] hover:border-[#53647a] hover:bg-[#1a2635] hover:text-white px-3 py-1.5 text-xs font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] sm:inline-flex"
            title="Switch Network"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                isArcMainnet ? "bg-emerald-500 shadow-xs" : "bg-rose-500"
              }`}
            />
            <span>
              {isArcMainnet ? "Arc Mainnet" : "Unsupported"}
            </span>
          </button>

          <button onClick={onOpenWallet} aria-label="Open Stillwater wallet" aria-haspopup="dialog" aria-expanded={walletOpen}
            className="inline-flex min-h-[42px] min-w-11 items-center justify-center gap-2 rounded-[10px] border border-[#344256] bg-[#151e2b] text-[#e7edf5] hover:border-[#53647a] hover:bg-[#1a2635] hover:text-white px-2.5 py-1.5 text-xs font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] lg:px-3 max-[680px]:min-h-[38px] max-[680px]:px-[9px]">
            <IconWallet size={16} /><span>Wallet</span>
          </button>
          {!isConnected ? <button onClick={() => open()} className="hidden min-h-[42px] items-center rounded-[10px] border border-[#344256] bg-[#151e2b] text-[#e7edf5] hover:border-[#53647a] hover:bg-[#1a2635] hover:text-white px-3 text-xs font-semibold sm:inline-flex">Connect</button> : null}

          {/* Session Authentication Status */}
          {isConnected && !user && onOpenAuthModal ? (
            <button
              onClick={onOpenAuthModal}
              className="hidden min-h-[42px] items-center rounded-[10px] border border-[#344256] bg-[#151e2b] text-[#e7edf5] hover:border-[#53647a] hover:bg-[#1a2635] hover:text-white px-3 py-1.5 text-xs font-semibold active:scale-[0.96] lg:inline-flex"
              title="Sign in with Ethereum to unlock automated execution"
            >
              Sign In (SIWE)
            </button>
          ) : user ? (
            <button
              onClick={onLogout}
              aria-label="Log out of Stillwater session"
              className="inline-flex min-h-[42px] items-center rounded-[10px] border border-[#344256] bg-[#151e2b] text-[#e7edf5] hover:border-[#53647a] hover:bg-[#1a2635] hover:text-white px-2.5 py-1.5 text-xs font-medium active:scale-[0.96]"
              title="Log out of Stillwater session"
            >
              <span className="hidden sm:inline">Log Out</span>
              <span className="sm:hidden">Exit</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
};
