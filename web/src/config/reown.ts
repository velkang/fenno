import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { QueryClient } from "@tanstack/react-query";
import { arc } from "@stillwater/chain";

// Reown Cloud Project ID: customizable via env with fallback for local dev
export const projectId =
  import.meta.env.VITE_REOWN_PROJECT_ID || "b56e18d47c72ab683b10814fe9495694";

export const networks = [arc] as const;

export const queryClient = new QueryClient();

export const wagmiAdapter = new WagmiAdapter({
  networks: [arc],
  projectId,
});

// The wallet modal follows the system light/dark setting, like the rest of the app.
const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function systemTheme(): "light" | "dark" {
  return darkQuery?.matches ? "dark" : "light";
}
function themeVariables(mode: "light" | "dark") {
  return {
    "--w3m-accent": mode === "dark" ? "#dcebe3" : "#1f3531",
    "--w3m-color-mix": mode === "dark" ? "#0e1614" : "#f4f0e6",
    "--w3m-color-mix-strength": 30,
    "--w3m-font-family": "Figtree, ui-sans-serif, system-ui, sans-serif",
    "--w3m-border-radius-master": "4px",
  };
}

export const modal = createAppKit({
  adapters: [wagmiAdapter],
  networks: [arc],
  defaultNetwork: arc,
  projectId,
  metadata: {
    name: "Fenno",
    description: "Automated Uniswap Liquidity Management on Arc",
    url: typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
    icons: ["https://avatars.githubusercontent.com/u/179229932"],
  },
  // Sign-in is email, Google or X only: no external wallets. The login account
  // only signs the sign-in message and withdrawal approvals; Stillwater wallets
  // hold the funds. EOA accounts keep those signatures plain ECDSA.
  features: {
    email: true,
    socials: ["google", "x"],
    emailShowWallets: false,
    connectMethodsOrder: ["email", "social"],
  },
  enableWallets: false,
  defaultAccountTypes: { eip155: "eoa" },
  themeMode: systemTheme(),
  themeVariables: themeVariables(systemTheme()),
});

darkQuery?.addEventListener("change", () => {
  modal.setThemeMode(systemTheme());
  modal.setThemeVariables(themeVariables(systemTheme()));
});
