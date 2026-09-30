import { formatUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import { Loading, Skeleton } from "./Skeleton";

const PRESET_BUTTON = "min-h-11 min-w-[60px] rounded-full border border-line px-3 text-[.95rem] font-medium text-ink enabled:hover:bg-tint disabled:cursor-not-allowed disabled:opacity-45";
const PRESETS = [25, 50, 75, 100] as const;

// Reads the wallet's live on-chain balance of any token through the API, so it also covers
// tokens sent to the wallet from outside Stillwater.
export function useTokenBalance(token: string | undefined, owner: string | undefined) {
  return useQuery({
    queryKey: ["token-balance", owner, token],
    queryFn: () => api.getTokenBalance(token as string).then((result) => BigInt(result.balance)),
    enabled: Boolean(token && owner),
  });
}

type Props = {
  balance: bigint | undefined;
  decimals: number;
  symbol: string;
  presets: boolean;
  unavailable?: boolean;
  onSelect: (amount: string) => void;
};

export function BalancePresets({ balance, decimals, symbol, presets, unavailable, onSelect }: Props) {
  return <div className="flex flex-wrap items-center justify-between gap-3">
    {!unavailable && balance === undefined ? (
      <Loading label="Loading your balance…" className="flex items-center gap-2 text-[.98rem] text-ink-muted">
        Wallet: <Skeleton className="h-4 w-24" />
      </Loading>
    ) : (
      <p className="text-[.98rem] text-ink-muted">Wallet: {unavailable ? "balance unavailable"
        : `${Number(formatUnits(balance!, decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${symbol}`}</p>
    )}
    {presets ? <div className="flex gap-2" role="group" aria-label="Sell a share of your balance">{PRESETS.map((percent) =>
      <button type="button" key={percent} className={PRESET_BUTTON} disabled={!balance}
        onClick={() => { if (balance) onSelect(formatUnits(balance * BigInt(percent) / 100n, decimals)); }}>
        {percent === 100 ? "Max" : `${percent}%`}</button>)}</div> : null}
  </div>;
}
