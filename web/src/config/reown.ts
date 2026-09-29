import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { QueryClient } from "@tanstack/react-query";
import { arc, arcTestnet } from "@stillwater/chain";

// Reown Cloud Project ID: customizable via env with fallback for local dev
export const projectId =
  import.meta.env.VITE_REOWN_PROJECT_ID || "b56e18d47c72ab683b10814fe9495694";

export const networks = [arcTestnet, arc] as const;

export const queryClient = new QueryClient();

export const wagmiAdapter = new WagmiAdapter({
  networks: [arcTestnet, arc],
  projectId,
});

export const modal = createAppKit({
  adapters: [wagmiAdapter],
  networks: [arcTestnet, arc],
  defaultNetwork: arcTestnet,
  projectId,
  metadata: {
    name: "Stillwater",
    description: "Automated Uniswap Liquidity Management on Arc",
    url: typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
    icons: ["https://avatars.githubusercontent.com/u/179229932"],
  },
  themeMode: "light",
  themeVariables: {
    "--w3m-accent": "#2563EB",
    "--w3m-border-radius-master": "2px",
    "--w3m-color-mix": "#F8FAFC",
    "--w3m-color-mix-strength": 20,
  },
});
