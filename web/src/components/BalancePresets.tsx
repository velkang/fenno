import { formatUnits } from "viem";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";

const PRESET_BUTTON = "min-h-8 cursor-pointer rounded-[7px] border border-[#344256] bg-[#151e2b] px-2.5 text-[.75rem] font-semibold text-[#dce5f2] enabled:hover:border-[#53647a] enabled:hover:bg-[#1a2635] disabled:cursor-not-allowed disabled:opacity-45";
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
  return <div className="mt-2.5 mb-6 flex flex-wrap items-center justify-between gap-2">
    <p className="text-[.78rem] text-[#9eacc0]">Wallet: {unavailable ? "balance unavailable" : balance === undefined ? "—"
      : `${Number(formatUnits(balance, decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${symbol}`}</p>
    {presets ? <div className="flex gap-1.5" role="group" aria-label="Sell a share of your balance">{PRESETS.map((percent) =>
      <button type="button" key={percent} className={PRESET_BUTTON} disabled={!balance}
        onClick={() => { if (balance) onSelect(formatUnits(balance * BigInt(percent) / 100n, decimals)); }}>
        {percent === 100 ? "Max" : `${percent}%`}</button>)}</div> : null}
  </div>;
}
