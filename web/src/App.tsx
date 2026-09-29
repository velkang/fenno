import React, { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { Header, type PageRoute } from "./components/Header";
import { AuthScreen } from "./components/AuthScreen";
import { ExplorePage } from "./pages/ExplorePage";
import { SwapPage } from "./pages/SwapPage";
import { PoolPage } from "./pages/PoolPage";
import { PositionsPage } from "./pages/PositionsPage";
import { WalletPanel } from "./components/WalletPanel";
import { IntentActionModal, type ModalType } from "./components/IntentActionModal";
import { ToastContainer, type ToastMessage } from "./components/Toast";
import { api, type AuthUser, type ManagedWalletRecord } from "./lib/api-client";
import type { AlphaWalletSummary } from "@actora/chain";

function getPageFromLocation(): PageRoute {
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/positions") return "positions";
  if (path === "/swap") return "swap";
  if (/^\/pools\/0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(path)) return "pool";

  if (path === "/") {
    const legacyHash = window.location.hash.toLowerCase();
    if (legacyHash === "#/positions") return "positions";
    if (legacyHash === "#/wallet") return "explore";
  }
  return "explore";
}

export const App: React.FC = () => {
  const { isConnected } = useAccount();

  // Navigation State (Page-based routing)
  const [activePage, setActivePage] = useState<PageRoute>(getPageFromLocation);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [poolAddress, setPoolAddress] = useState<string | null>(() => {
    const match = window.location.pathname.match(/^\/pools\/(0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64}))\/?$/);
    return match?.[1] ?? null;
  });

  // Normalize legacy hash URLs and keep the page in sync with browser navigation.
  useEffect(() => {
    const syncPageFromLocation = () => {
      const page = getPageFromLocation();
      setActivePage(page);
      const match = window.location.pathname.match(/^\/pools\/(0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64}))\/?$/);
      setPoolAddress(match?.[1] ?? null);

      const path = page === "pool" ? window.location.pathname : `/${page}`;
      if (window.location.pathname !== path || window.location.hash) {
        window.history.replaceState(null, "", path);
      }
    };

    syncPageFromLocation();
    window.addEventListener("popstate", syncPageFromLocation);
    return () => window.removeEventListener("popstate", syncPageFromLocation);
  }, []);

  const handleNavigate = (page: PageRoute) => {
    if (page === "pool") return;
    setActivePage(page);
    const path = `/${page}`;
    if (window.location.pathname !== path || window.location.hash) {
      window.history.pushState(null, "", path);
    }
  };

  const handleSelectPool = (address: string) => {
    setPoolAddress(address);
    setActivePage("pool");
    window.history.pushState(null, "", `/pools/${address}`);
  };

  // State
  const [user, setUser] = useState<AuthUser | null>(null);
  const [wallet, setWallet] = useState<ManagedWalletRecord | null>(null);
  const [summary, setSummary] = useState<AlphaWalletSummary | null>(null);
  const [modal, setModal] = useState<ModalType>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (type: "success" | "error" | "info", title: string, message?: string) => {
    const id = `toast_${Date.now()}_${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, title, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Check existing session
  useEffect(() => {
    let mounted = true;
    async function checkSession() {
      try {
        const res = await api.getMe();
        if (mounted && res?.user) {
          setUser(res.user);
        }
      } catch {
        // Not authenticated
      }
    }
    checkSession();
    return () => {
      mounted = false;
    };
  }, []);

  // Load wallet data and summary in parallel
  const refreshData = useCallback(async () => {
    if (!user) return;
    try {
      const [walletRes, summaryRes] = await Promise.all([
        api.getMyWallet().catch(() => null),
        api.getWalletSummary().catch(() => null),
      ]);
      if (walletRes?.wallet) setWallet(walletRes.wallet);
      if (summaryRes?.summary) setSummary(summaryRes.summary);
    } catch (err) {
      console.error("Failed to load wallet data", err);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      refreshData();
      const interval = setInterval(refreshData, 15000); // 15s poll
      return () => clearInterval(interval);
    }
  }, [user, refreshData]);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setUser(null);
    setWallet(null);
    setSummary(null);
    addToast("info", "Logged Out", "Actora session ended.");
  };

  const handleProvision = async () => {
    try {
      await api.provisionWallet();
      await refreshData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Provisioning failed";
      addToast("error", "Provisioning Failed", msg);
    }
  };

  return (
    <>
      <Header
        user={user}
        activePage={activePage}
        onNavigate={handleNavigate}
        activePositionsCount={summary?.positions?.length ?? 0}
        onLogout={handleLogout}
        onOpenAuthModal={() => setShowAuthModal(true)}
        onOpenWallet={() => setShowWallet(true)}
        walletOpen={showWallet}
      />

      {/* Guest Mode Indicator Banner */}
      {!user && (
        <div className="border-b border-[#263243] bg-[#111827] px-4 py-2.5 text-center text-xs text-[#b6c1d1] max-[680px]:px-3.5 max-[680px]:py-2 max-[680px]:text-[.7rem] max-[680px]:leading-[1.45]">
          <span className="font-semibold text-[#e7edf5]">Viewing Actora in Preview Mode.</span>{" "}
          {activePage === "explore"
            ? "Find an Arc token pool to review."
            : "Review pools and positions, or swap with your Actora wallet."}{" "}
          <button
            onClick={() => setShowAuthModal(true)}
            className="ml-1 font-semibold text-[#6ee7b7] underline hover:text-[#a7f3d0]"
          >
            {isConnected ? "Sign In (SIWE)" : "Connect Wallet to Sign In"}
          </button>
        </div>
      )}

      <main className="mx-auto w-full max-w-none flex-1 bg-[#0b0f19] px-[clamp(18px,3.2vw,52px)] pt-6 pb-[42px] text-[#f3f4f6] max-[680px]:px-4 max-[680px]:pt-4 max-[680px]:pb-[30px]">
        {activePage === "explore" && <ExplorePage onSelectPool={handleSelectPool} />}
        {activePage === "pool" && poolAddress && <PoolPage
          address={poolAddress} wallet={wallet} summary={summary} onRefresh={refreshData}
          onNotify={addToast} onOpenAuth={() => setShowAuthModal(true)} />}
        {activePage === "swap" && <SwapPage wallet={wallet} summary={summary}
          onRefresh={refreshData} onNotify={addToast} onOpenAuth={() => setShowAuthModal(true)} />}
        {activePage === "positions" && (
          <PositionsPage
            summary={summary}
            wallet={wallet}
            onRefresh={refreshData}
            onNotify={addToast}
            onOpenModal={(m) => setModal(m)}
          onNavigateDeposit={() => handleNavigate("explore")}
          />
        )}

      </main>
      <WalletPanel open={showWallet} wallet={wallet} canProvision={user !== null}
        ownerAddress={user?.ownerAddress ?? user?.address} summary={summary}
        onClose={() => setShowWallet(false)} onProvision={handleProvision}
        onRefresh={refreshData} onOpenAuth={() => { setShowWallet(false); setShowAuthModal(true); }}
        onNotify={addToast} />

      {/* SIWE Auth Modal Overlay */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-lg">
            <AuthScreen
              onAuthSuccess={(newUser) => {
                setUser(newUser);
                setShowAuthModal(false);
                addToast("success", "Welcome to Actora", "SIWE session established.");
              }}
              onError={(msg) => addToast("error", "Authentication Error", msg)}
              onClose={() => setShowAuthModal(false)}
            />
          </div>
        </div>
      )}

      <IntentActionModal
        modal={modal}
        summary={summary}
        currentTick={summary?.pool?.tick}
        onClose={() => setModal(null)}
        onSuccess={refreshData}
        onNotify={addToast}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
};
