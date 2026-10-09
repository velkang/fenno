import React from "react";
import { useAccount } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import type { AuthUser } from "../lib/api-client";
import { IconBell, IconRipple } from "./Icons";
import { Underline } from "./Underline";

export type PageRoute = "pond" | "positions" | "explore" | "pool" | "swap" | "alerts";

type Props = {
  user: AuthUser | null;
  walletAddress?: string;
  activePage: PageRoute;
  onNavigate: (page: PageRoute) => void;
  onOpenAuthModal?: () => void;
  onOpenWallet: () => void;
  walletOpen?: boolean;
  /** Tomo has alerts the user hasn't opened yet. */
  alertsUnread?: boolean;
};

const NAV: { key: Exclude<PageRoute, "pool" | "alerts">; label: string }[] = [
  { key: "pond", label: "Pond" },
  { key: "positions", label: "Positions" },
  { key: "explore", label: "Explore pools" },
  { key: "swap", label: "Swap" },
];

const PILL = "inline-flex min-h-11 items-center gap-2.5 rounded-full border border-line px-4 text-[.95rem] font-medium text-ink transition-colors hover:bg-tint";

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const Header: React.FC<Props> = ({
  user, walletAddress, activePage, onNavigate, onOpenAuthModal, onOpenWallet, walletOpen = false, alertsUnread = false,
}) => {
  const { open } = useAppKit();
  const { isConnected } = useAccount();

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-paper/95 px-[clamp(16px,4vw,80px)] text-ink backdrop-blur">
      <div className="mx-auto grid min-h-[84px] max-w-[1440px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[clamp(16px,3.5vw,56px)] max-[760px]:min-h-0 max-[760px]:grid-cols-[minmax(0,1fr)_auto] max-[760px]:pt-3">
        <button type="button" onClick={() => onNavigate("pond")} aria-label="Fenno home"
          className="flex min-h-11 items-center gap-3 rounded-lg text-ink">
          <IconRipple size={36} className="text-link" />
          <span className="text-[1.7rem] font-semibold tracking-[-0.01em] max-[760px]:text-[1.4rem]">Fenno</span>
        </button>

        <nav aria-label="Main" className="flex items-center gap-[clamp(18px,2.8vw,40px)] max-[760px]:col-span-full max-[760px]:row-start-2 max-[760px]:justify-between max-[760px]:pt-1">
          {NAV.map((item) => {
            const active = activePage === item.key || (activePage === "pool" && item.key === "explore");
            return (
              <button key={item.key} type="button" onClick={() => onNavigate(item.key)} aria-current={active ? "page" : undefined}
                className={`relative min-h-11 text-[1.05rem] transition-colors max-[760px]:flex-1 ${active
                  ? "text-ink" : "text-ink-muted hover:text-ink"}`}>
                {item.label}
                {active ? <Underline id="nav-underline" /> : null}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center justify-end gap-2.5">
          {user ? (
            <button type="button" onClick={() => onNavigate("alerts")} aria-current={activePage === "alerts" ? "page" : undefined}
              aria-label={alertsUnread ? "Alerts, new" : "Alerts"}
              className={`relative inline-flex size-11 items-center justify-center rounded-full border border-line transition-colors hover:bg-tint ${activePage === "alerts" ? "bg-tint text-ink" : "text-ink-muted"}`}>
              <IconBell />
              {alertsUnread ? <span aria-hidden="true" className="absolute top-2 right-2.5 size-2.5 rounded-full bg-koi ring-2 ring-paper" /> : null}
            </button>
          ) : null}
          {user ? (
            <button type="button" onClick={onOpenWallet} aria-haspopup="dialog" aria-expanded={walletOpen}
              aria-label="Open your Fenno wallet" className={PILL}>
              {walletAddress ? shortAddress(walletAddress) : "Wallet"}
            </button>
          ) : (
            <button type="button" onClick={onOpenAuthModal ?? (() => open())}
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-[.95rem] font-semibold text-on-accent transition-colors hover:bg-accent-hover">
              {isConnected ? "Sign in" : "Get started"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
