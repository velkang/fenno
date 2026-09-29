import React, { useState, useMemo, useEffect } from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount } from "wagmi";
import {
  ALPHA_POOL,
  type AlphaWalletSummary,
  type DiscoveredPool,
} from "@actora/chain";
import { useAppKit } from "@reown/appkit/react";
import { api, type ManagedWalletRecord, type PublicPool, type TokenPoolDiscovery } from "../lib/api-client";
import { alignTick, pairedAmount, priceToTick, tickToPrice } from "../lib/range-math";
import { ensureV4Allowance, v4MintApprovals } from "../lib/v4-actions";
import { MeteoraRangeBar } from "../components/MeteoraRangeBar";
import { PositionReview, PRIMARY_ACTION } from "../components/PositionReview";
import { STRATEGIES, StrategyCards, type StrategyKey } from "../components/StrategyCards";
import { formatPoolPrice } from "./ExplorePage";
import {
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconExternalLink,
  IconSliders,
  IconWallet,
  IconSearch,
} from "../components/Icons";

type Props = {
  initialPoolAddress?: string;
  initialTokenAddress?: string;
  // Set for pools opened from the pool page; a v4 pool is driven entirely from this record.
  pool?: PublicPool;
  onNeedTokens?: () => void;
  wallet: ManagedWalletRecord | null;
  summary: AlphaWalletSummary | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
  onOpenApproveModal?: (token: "USDC" | "cirBTC") => void;
  onOpenAuth?: () => void;
};

function formatRaw(raw: string | undefined, decimals: number): string {
  if (!raw) return "—";
  try {
    const formatted = formatUnits(BigInt(raw), decimals);
    const num = Number(formatted);
    return num.toLocaleString("en-US", { maximumFractionDigits: 6 });
  } catch {
    return "—";
  }
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const AMOUNT_PERCENTS = [25, 50, 75, 100];

function formatFeeTier(fee: number | undefined): string {
  if (fee === undefined) return "—";
  if (fee === 0x800000) return "Varying";
  return `${(fee / 10_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`;
}

function tokenMarkText(symbol: string): string {
  return symbol === "cirBTC" ? "cB" : symbol.slice(0, 2).toUpperCase();
}

const MARK_REGULAR = "inline-grid size-10 text-[.65rem]";
const MARK_SMALL = "flex size-8 items-center text-[.6rem]";
const MARK_DEFAULT = "border-[#344256] bg-[#172335] text-[#e9f1fc]";
const MARK_AMBER = "border-[#bd7c1c] bg-[#754811] text-[#fff3d3]";
const MARK_BLUE = "border-[#2d78c4] bg-[#124b8a] text-[#e4f2ff]";
const STATION_HEADING = "mb-[18px] max-[680px]:mb-3 [&_h2]:mt-0 [&_h2]:mb-0.5 [&_h2]:text-[1.18rem] [&_h2]:font-[650] [&_h2]:tracking-[-0.025em] [&_h2]:text-[#f3f4f6] max-[680px]:[&_h2]:text-[1.1rem] [&_p]:m-0 [&_p]:text-[.84rem] [&_p]:text-[#b6c1d1] max-[680px]:[&_p]:text-[.8rem]";
const DETAIL_ROW = "flex min-h-[39px] items-center justify-between gap-2.5 border-b border-[#29364a] text-[.82rem] text-[#b6c1d1]";
const DETAIL_VALUE = "m-0 flex min-w-0 items-center justify-end gap-2 text-right text-[#e2e8f0]";
const PRO_ITEM = "grid min-w-0 gap-0.5 text-[.72rem] text-[#b6c1d1] [&_strong]:overflow-hidden [&_strong]:font-mono [&_strong]:text-[.73rem] [&_strong]:font-medium [&_strong]:text-ellipsis [&_strong]:text-[#e5ebf3]";
const DISCOVERY_STATE = "mx-0.5 mt-2 mb-0 text-[0.8125rem]";
const SUMMARY_ITEM = "grid min-w-0 gap-[3px] border-l border-[#344256] px-[clamp(12px,3.4vw,54px)] first:border-l-0 first:pl-0 max-[680px]:px-3 max-[680px]:odd:border-l-0 max-[680px]:odd:pl-0 max-[680px]:even:pr-0 [&_span]:text-[.76rem] [&_span]:text-[#b6c1d1] [&_strong]:overflow-hidden [&_strong]:text-base [&_strong]:font-[550] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-[#e7edf5] [&_strong]:tabular-nums max-[680px]:[&_strong]:text-[.88rem]";

function TokenMark({ symbol, className }: { symbol: string; className: string }) {
  return (
    <span className={`flex-none place-items-center rounded-full border font-bold tracking-[-0.04em] ${className}`} aria-hidden="true">
      {tokenMarkText(symbol)}
    </span>
  );
}

export const DepositPage: React.FC<Props> = ({
  initialPoolAddress,
  initialTokenAddress,
  pool,
  onNeedTokens,
  wallet,
  summary,
  onRefresh,
  onNotify,
  onOpenAuth,
}) => {
  const { open } = useAppKit();
  const { isConnected } = useAccount();
  const v4Pool = pool?.protocol === "uniswap-v4" ? pool : null;

  // Search & Token selection omnibar state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string>(ALPHA_POOL.token0.address);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<TokenPoolDiscovery | null>(null);
  const [selectedPoolAddress, setSelectedPoolAddress] = useState("");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialTokenAddress || !initialPoolAddress || v4Pool) return;
    let current = true;
    setDiscovering(true);
    api.discoverTokenPools(initialTokenAddress).then((result) => {
      if (!current) return;
      if (!result.pools.some((pool) => pool.address.toLowerCase() === initialPoolAddress.toLowerCase())) {
        throw new Error("This pool is no longer available for the selected token.");
      }
      setDiscovery(result);
      setSelectedTokenAddress(initialTokenAddress);
      setSelectedPoolAddress(initialPoolAddress);
      setSearchQuery(initialTokenAddress);
      setDiscoveryError(null);
    }).catch((error: unknown) => {
      if (current) setDiscoveryError(error instanceof Error ? error.message : "Could not load pool");
    }).finally(() => { if (current) setDiscovering(false); });
    return () => { current = false; };
  }, [initialPoolAddress, initialTokenAddress, v4Pool]);

  // Strategy & Pro mode
  const [strategy, setStrategy] = useState<StrategyKey>("balanced");
  const [showProDrawer, setShowProDrawer] = useState(false);

  // Deposit inputs
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");

  // Execution states
  const [reviewing, setReviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [v4Balances, setV4Balances] = useState<{ token: string; usdc: string } | null>(null);

  const isCanonical = !v4Pool && selectedTokenAddress.toLowerCase() === ALPHA_POOL.token0.address.toLowerCase()
    && (!initialPoolAddress || initialPoolAddress.toLowerCase() === ALPHA_POOL.address.toLowerCase());
  const canonicalPool = summary?.pool;

  const activeCustomPool = useMemo<DiscoveredPool | undefined>(
    () => discovery?.pools.find((p) => p.address.toLowerCase() === selectedPoolAddress.toLowerCase()),
    [discovery, selectedPoolAddress],
  );
  const v4NativeUsdc = !!v4Pool && [v4Pool.token0, v4Pool.token1].some((address) => address.toLowerCase() === zeroAddress);

  // token0 is always the listed token and token1 always USDC, whatever the pool's own order.
  const token0 = useMemo(() => {
    if (v4Pool) return { ...v4Pool.token, name: v4Pool.token.symbol };
    if (isCanonical) return { symbol: "cirBTC", name: "Circulating Bitcoin", decimals: 8, address: ALPHA_POOL.token0.address };
    if (discovery?.token) return { ...discovery.token, name: discovery.token.symbol };
    return { symbol: "TOKEN", name: "Arc Custom Token", decimals: 18, address: selectedTokenAddress };
  }, [v4Pool, isCanonical, discovery, selectedTokenAddress]);

  const token1 = useMemo(() => {
    if (v4Pool) return { symbol: "USDC", decimals: v4NativeUsdc ? 18 : 6,
      address: v4NativeUsdc ? zeroAddress : ALPHA_POOL.token1.address };
    if (isCanonical) return { symbol: "USDC", decimals: 6, address: ALPHA_POOL.token1.address };
    return discovery?.usdc ?? { symbol: "USDC", decimals: 6, address: "" };
  }, [v4Pool, v4NativeUsdc, isCanonical, discovery]);

  const poolAddress = v4Pool ? v4Pool.address : isCanonical ? ALPHA_POOL.address : activeCustomPool?.address ?? "";
  const usdcIsPoolToken0 = v4Pool
    ? v4Pool.token0.toLowerCase() !== v4Pool.token.address.toLowerCase()
    : !isCanonical && activeCustomPool?.token0.address.toLowerCase() === token1.address.toLowerCase();
  const poolFee = v4Pool ? v4Pool.fee : isCanonical ? ALPHA_POOL.fee : activeCustomPool?.fee;
  const feeTier = formatFeeTier(poolFee);
  const rangeWidth = STRATEGIES.find((entry) => entry.key === strategy)?.label ?? "±10%";

  // Current spot tick & price
  const currentTick = useMemo(() => {
    if (v4Pool) return v4Pool.tick;
    if (isCanonical) return canonicalPool?.tick ?? 67648;
    return activeCustomPool?.tick ?? 0;
  }, [v4Pool, isCanonical, canonicalPool, activeCustomPool]);

  const tickSpacing = useMemo(() => {
    if (v4Pool) return v4Pool.tickSpacing;
    if (isCanonical) return canonicalPool?.tickSpacing ?? 1;
    return activeCustomPool?.tickSpacing ?? 60;
  }, [v4Pool, isCanonical, canonicalPool, activeCustomPool]);

  const spotPrice = useMemo(() => {
    if (isCanonical && canonicalPool?.token1PerToken0) {
      return Number(canonicalPool.token1PerToken0);
    }
    const computed = usdcIsPoolToken0
      ? 1 / tickToPrice(currentTick, token1.decimals, token0.decimals)
      : tickToPrice(currentTick, token0.decimals, token1.decimals);
    return Number.isFinite(computed) && computed > 0 ? computed : 0;
  }, [isCanonical, canonicalPool, currentTick, token0.decimals, token1.decimals, usdcIsPoolToken0]);

  // Range boundaries based on strategy preset
  const { minPrice, maxPrice, tickLower, tickUpper } = useMemo(() => {
    const spreadPct = STRATEGIES.find((entry) => entry.key === strategy)?.spread ?? 0.1;

    const minP = spotPrice * (1 - spreadPct);
    const maxP = spotPrice * (1 + spreadPct);

    const rawLower = usdcIsPoolToken0
      ? priceToTick(1 / maxP, token1.decimals, token0.decimals)
      : priceToTick(minP, token0.decimals, token1.decimals);
    const rawUpper = usdcIsPoolToken0
      ? priceToTick(1 / minP, token1.decimals, token0.decimals)
      : priceToTick(maxP, token0.decimals, token1.decimals);

    return {
      minPrice: minP,
      maxPrice: maxP,
      tickLower: alignTick(rawLower, tickSpacing),
      tickUpper: alignTick(rawUpper, tickSpacing),
    };
  }, [strategy, spotPrice, token0.decimals, token1.decimals, tickSpacing, usdcIsPoolToken0]);

  useEffect(() => {
    if (!v4Pool || !wallet) return;
    let current = true;
    api.getV4Allowances(v4Pool.address).then((result) => {
      if (!current) return;
      const find = (address: string) => result.allowances.find((entry) =>
        entry.token.toLowerCase() === address.toLowerCase())?.balance ?? "0";
      setV4Balances({ token: find(v4Pool.token.address),
        usdc: v4NativeUsdc ? result.nativeBalance : find(ALPHA_POOL.token1.address) });
    }).catch(() => { if (current) setV4Balances(null); });
    return () => { current = false; };
  }, [v4Pool, v4NativeUsdc, wallet?.id, executing]);

  // Wallet balances in raw units, for display and shortfall checks.
  const rawBalance0 = v4Pool ? v4Balances?.token : isCanonical ? summary?.balances?.cirBtc?.raw : discovery?.token?.balance;
  const rawBalance1 = v4Pool ? v4Balances?.usdc : isCanonical ? summary?.balances?.usdc?.raw : discovery?.usdc?.balance;
  const balance0 = rawBalance0 ? formatRaw(rawBalance0, token0.decimals) : "0";
  const balance1 = rawBalance1 ? formatRaw(rawBalance1, token1.decimals) : "0";

  const toRaw = (value: string, decimals: number): bigint | null => {
    try { return parseUnits(value.trim().replace(",", "."), decimals); } catch { return null; }
  };
  const raw0 = toRaw(amount0, token0.decimals);
  const raw1 = toRaw(amount1, token1.decimals);
  const short0 = wallet && raw0 !== null && raw0 > BigInt(rawBalance0 ?? "0");
  const short1 = wallet && raw1 !== null && raw1 > BigInt(rawBalance1 ?? "0");
  const hasAmounts = (raw0 ?? 0n) > 0n || (raw1 ?? 0n) > 0n;

  // Fills one side with a share of the wallet balance. USDC also pays Arc network fees, so its
  // share is taken after holding back 0.1 USDC (the signer's per-transaction fee cap).
  const percentOfBalance = (side: "token0" | "token1", percent: number): string => {
    const decimals = side === "token0" ? token0.decimals : token1.decimals;
    const balance = BigInt((side === "token0" ? rawBalance0 : rawBalance1) ?? "0");
    const reserve = side === "token1" ? 10n ** BigInt(decimals - 1) : 0n;
    const spendable = balance > reserve ? balance - reserve : 0n;
    const amount = (spendable * BigInt(percent)) / 100n;
    return amount > 0n ? formatUnits(amount, decimals) : "";
  };

  // Handle auto-discovery when user enters a 42-char contract address
  const handleQueryChange = (val: string) => {
    setSearchQuery(val);
    const clean = val.trim();
    if (clean.startsWith("0x") && clean.length === 42) {
      resolveAddress(clean);
    }
  };

  const resolveAddress = async (addr: string) => {
    if (addr.toLowerCase() === ALPHA_POOL.token0.address.toLowerCase()) {
      setSelectedTokenAddress(ALPHA_POOL.token0.address);
      setDiscovery(null);
      setDiscoveryError(null);
      return;
    }

    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const res = await api.discoverTokenPools(addr);
      setDiscovery(res);
      setSelectedTokenAddress(addr);
      if (res.pools.length > 0) {
        setSelectedPoolAddress(res.pools[0].address);
        onNotify("success", "Token Discovered", `Resolved ${res.token.symbol} with ${res.pools.length} active pool(s)`);
      } else {
        setDiscoveryError(`No active Uniswap v3 pool found for ${res.token.symbol} against USDC on Arc.`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to query Arc blockchain";
      setDiscoveryError(msg);
      onNotify("error", "Discovery Error", msg);
    } finally {
      setDiscovering(false);
    }
  };

  // Sends a prepared intent and waits for Arc to confirm it.
  const executeAndWait = async (intentId: string): Promise<boolean> => {
    const res = await api.executeIntent(intentId);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const rec = await api.reconcileAttempt(res.attemptId);
      if (rec.status === "confirmed") return true;
      if (rec.status !== "pending" && rec.status !== "submitted") {
        throw new Error(rec.reasonCode || "Transaction did not confirm");
      }
    }
    onNotify("info", "Still confirming", "Arc has not confirmed the transaction yet. Check My Positions shortly.");
    return false;
  };

  const requireWallet = (): boolean => {
    if (wallet) return true;
    if (onOpenAuth) onOpenAuth();
    else open();
    return false;
  };

  // Which tokens still need an approval before the position can open. v4 allowances are
  // checked at confirm time, so both non-native tokens are listed as "if needed".
  const approvalsNeeded = (): Array<{ side: "token0" | "token1"; symbol: string; amount: bigint }> => {
    const sides = [
      { side: "token0" as const, symbol: token0.symbol, amount: raw0 ?? 0n, address: token0.address },
      { side: "token1" as const, symbol: token1.symbol, amount: raw1 ?? 0n, address: token1.address },
    ].filter((entry) => entry.amount > 0n);
    if (v4Pool) return sides.filter((entry) => entry.address.toLowerCase() !== zeroAddress);
    const allowance = (side: "token0" | "token1") => BigInt((isCanonical
      ? side === "token0" ? summary?.allowances?.positionManager?.cirBtc?.raw : summary?.allowances?.positionManager?.usdc?.raw
      : side === "token0" ? discovery?.token?.allowance : discovery?.usdc?.allowance) ?? "0");
    return sides.filter((entry) => allowance(entry.side) < entry.amount);
  };

  const handleReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requireWallet()) return;
    if (!hasAmounts) {
      onNotify("error", "Enter an amount", "Type how much you want to add.");
      return;
    }
    setReviewing(true);
  };

  const approveV3 = async (side: "token0" | "token1", amount: bigint) => {
    if (isCanonical) {
      const res = await api.prepareApproval(side === "token0" ? "cirBTC" : "USDC", amount.toString(), crypto.randomUUID());
      return executeAndWait(res.intentId);
    }
    if (!discovery || !activeCustomPool) throw new Error("Pool is not loaded yet.");
    const res = await api.prepareTokenApproval({
      tokenAddress: side === "token0" ? discovery.token.address : discovery.usdc.address,
      poolAddress: activeCustomPool.address,
      amount: amount.toString(),
      idempotencyKey: crypto.randomUUID(),
    });
    return executeAndWait(res.intentId);
  };

  const mint = async (): Promise<boolean> => {
    const amountToken = (raw0 ?? 0n).toString();
    const amountUsdc = (raw1 ?? 0n).toString();
    if (v4Pool) {
      const res = await api.prepareV4Mint({ poolId: v4Pool.address,
        ...v4Desired(), tickLower, tickUpper, slippageBps: 100,
        deadline: String(Math.floor(Date.now() / 1000) + 10 * 60),
        idempotencyKey: crypto.randomUUID() });
      return executeAndWait(res.intentId);
    }
    const common = { tickLower, tickUpper, slippageBps: 100,
      deadline: String(Math.floor(Date.now() / 1000) + 1800), idempotencyKey: crypto.randomUUID() };
    if (isCanonical) {
      const res = await api.prepareMint({ ...common, amountCirBtc: amountToken, amountUsdc });
      return executeAndWait(res.intentId);
    }
    if (!activeCustomPool) throw new Error("Pool is not loaded yet.");
    const res = await api.prepareTokenMint({ ...common, tokenAddress: token0.address,
      poolAddress: activeCustomPool.address, amountToken, amountUsdc });
    return executeAndWait(res.intentId);
  };

  // Desired amounts in the v4 pool's own currency order.
  const v4Desired = () => {
    const token = (raw0 ?? 0n).toString();
    const usdc = (raw1 ?? 0n).toString();
    return { amount0Desired: usdcIsPoolToken0 ? usdc : token, amount1Desired: usdcIsPoolToken0 ? token : usdc };
  };

  const handleConfirm = async () => {
    if (!requireWallet() || !wallet) return;
    setExecuting(true);
    try {
      if (v4Pool) {
        const desired = v4Desired();
        const required = await v4MintApprovals({ poolId: v4Pool.address, tickLower, tickUpper,
          amount0Desired: BigInt(desired.amount0Desired), amount1Desired: BigInt(desired.amount1Desired),
          slippageBps: 100, recipient: wallet.address });
        for (const { token, amount } of required) {
          setProgress(`Approving ${token.toLowerCase() === token0.address.toLowerCase() ? token0.symbol : token1.symbol}…`);
          if (!await ensureV4Allowance({ poolId: v4Pool.address, token, amount, purpose: "mint",
            execute: executeAndWait })) return;
        }
      } else {
        for (const { side, symbol, amount } of approvalsNeeded()) {
          setProgress(`Approving ${symbol}…`);
          if (!await approveV3(side, amount)) return;
        }
      }
      setProgress("Opening your position…");
      if (await mint()) {
        onNotify("success", "Position opened", "You're now earning trading fees. Track it in My Positions.");
        setReviewing(false);
        setAmount0("");
        setAmount1("");
        await onRefresh();
        if (discovery) api.discoverTokenPools(discovery.token.address).then(setDiscovery).catch(() => undefined);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not open the position";
      onNotify("error", "Position not opened", msg === "V4_MINT_SIMULATION_FAILED" || msg === "V4_POOL_NOT_EXECUTABLE"
        ? "This pool can't accept new positions through Actora right now. Nothing was sent." : msg);
    } finally {
      setExecuting(false);
      setProgress(null);
    }
  };

  const pairFor = (from: "token" | "usdc", value: string) => pairedAmount({
    from, value, currentTick, tickLower, tickUpper, spotPrice,
    tokenDecimals: token0.decimals, usdcDecimals: token1.decimals, usdcIsPoolToken0,
  });

  const handleAmount0Change = (val: string) => {
    setAmount0(val);
    setAmount1(pairFor("token", val));
  };

  const handleAmount1Change = (val: string) => {
    setAmount1(val);
    setAmount0(pairFor("usdc", val));
  };

  const handleStrategy = (next: StrategyKey) => {
    setStrategy(next);
    setAmount0("");
    setAmount1("");
    setReviewing(false);
  };

  const handleSelectPool = (address: string) => {
    setSelectedPoolAddress(address);
    setAmount0("");
    setAmount1("");
    setReviewing(false);
  };

  const approvals = reviewing ? approvalsNeeded() : [];

  if (initialPoolAddress && !v4Pool && !isCanonical && !activeCustomPool) {
    return <p className={`${DISCOVERY_STATE} ${discoveryError ? "text-[#fca5a5]" : "text-[#a7f3d0]"}`} role={discoveryError ? "alert" : "status"}>
      {discoveryError ?? "Loading selected pool and range…"}</p>;
  }

  return (
    <div className="mx-auto w-[min(100%,1586px)] font-sans text-[0.9375rem] leading-normal text-[#f3f4f6] [-webkit-tap-highlight-color:transparent] motion-reduce:[&_*]:!transition-none [&_:is(button,a,input,select):focus-visible]:outline-2 [&_:is(button,a,input,select):focus-visible]:outline-offset-3 [&_:is(button,a,input,select):focus-visible]:outline-[#6ee7b7]">
      {!initialPoolAddress ? <div className="min-h-[62px] max-[680px]:min-h-[54px]">
        <div className="flex min-h-[60px] items-center gap-3.5 rounded-[10px] border border-[#344256] bg-[#151e2b] px-[17px] text-[#b6c1d1] focus-within:border-[#10b981] focus-within:shadow-[0_0_0_1px_#10b981] max-[680px]:min-h-[52px] max-[680px]:gap-2.5 max-[680px]:px-3 [&>svg]:flex-none [&>svg]:text-[#9eacc0]">
          <IconSearch size={20} aria-hidden="true" />
          <label className="sr-only" htmlFor="token-search">Paste an Arc token contract address</label>
          <input
            id="token-search"
            className="min-h-14 w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-[1.05rem] text-[#f3f4f6] shadow-none placeholder:text-[#aab6c8] placeholder:opacity-100 focus:border-0 focus:shadow-none max-[680px]:min-h-12 max-[680px]:text-[.9rem]"
            type="text"
            value={searchQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Paste an Arc token contract address"
            autoComplete="off"
            spellCheck={false}
          />
          {searchQuery ? (
            <button
              type="button"
              className="inline-grid size-[34px] flex-none cursor-pointer place-items-center border-0 border-l border-[#344256] bg-transparent text-[#b6c1d1]"
              aria-label="Clear token search"
              onClick={() => setSearchQuery("")}
            >
              <IconClose size={16} />
            </button>
          ) : null}
        </div>
        {discovering ? (
          <p className={`${DISCOVERY_STATE} text-[#a7f3d0]`} role="status">Checking Arc for token details and active pools…</p>
        ) : discoveryError ? (
          <p className={`${DISCOVERY_STATE} text-[#fca5a5]`} role="alert">{discoveryError}</p>
        ) : null}
      </div> : null}

      <div className="flex min-h-[90px] items-center justify-between gap-4 pt-3 pb-[18px] max-[680px]:min-h-[71px] max-[680px]:items-start max-[680px]:pt-[13px] max-[680px]:pb-[15px] max-[390px]:flex-wrap">
        <div className="flex min-w-0 items-center gap-3 max-[680px]:flex-wrap max-[680px]:gap-[7px]">
          <TokenMark symbol={token0.symbol} className={`${MARK_REGULAR} ${MARK_AMBER} max-[680px]:size-[34px]`} />
          <span className="text-[1.4rem] text-[#738198]" aria-hidden="true">/</span>
          <TokenMark symbol={token1.symbol} className={`${MARK_REGULAR} ${MARK_DEFAULT} max-[680px]:size-[34px]`} />
          <h1 className="m-0 overflow-hidden text-[clamp(1.4rem,2.2vw,1.8rem)] font-[650] tracking-[-0.035em] text-ellipsis whitespace-nowrap text-[#f3f4f6] max-[680px]:w-[calc(100%-88px)] max-[680px]:text-[1.18rem]">{token0.symbol} / {token1.symbol}</h1>
          <span className="inline-flex min-h-8 items-center justify-center rounded-lg border border-[#344256] bg-[#151e2b] px-2.5 py-[3px] text-[0.8125rem] font-[550] whitespace-nowrap text-[#e2e8f0] max-[680px]:ml-1 max-[680px]:min-h-[27px] max-[680px]:text-[.73rem]">{feeTier} fee</span>
        </div>
        {poolAddress ? (
          <a
            className="inline-flex min-h-10 items-center gap-2 rounded-[9px] border border-[#344256] px-3 py-[7px] text-[0.8125rem] text-[#dce5f2] no-underline transition-[background-color,border-color] duration-140 ease-[ease] hover:border-[#53647a] hover:bg-[#151e2b] max-[680px]:min-h-[34px] max-[680px]:gap-[5px] max-[680px]:px-2 max-[680px]:py-[5px] max-[680px]:text-[.72rem] max-[680px]:whitespace-nowrap max-[390px]:ml-auto [&>svg:last-child]:text-[#aab6c8]"
            href={`https://explorer.arc.io/address/${poolAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            <span>View on Explorer</span>
            <IconExternalLink size={14} />
          </a>
        ) : null}
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(235px,0.9fr)_minmax(340px,1.25fr)_minmax(330px,1fr)] items-stretch max-[1180px]:grid-cols-[minmax(245px,0.85fr)_minmax(340px,1.15fr)] max-[1180px]:gap-y-7 max-[1180px]:[grid-template-areas:'pool_range''amounts_amounts'] max-[680px]:grid-cols-[minmax(0,1fr)] max-[680px]:gap-y-[22px] max-[680px]:[grid-template-areas:'amounts''pool''range']">
        <section className="min-w-0 pr-[22px] max-[1180px]:[grid-area:pool] max-[680px]:px-0" aria-labelledby="pool-heading">
          <header className={STATION_HEADING}>
            <h2 id="pool-heading">1. The pool</h2>
            <p>Traders swap {token0.symbol} and USDC here. You supply both tokens and earn a share of the fees they pay.</p>
          </header>

          <div className="mb-[18px] flex min-h-[76px] items-center gap-3 rounded-[10px] border border-[#344256] bg-[#151e2b] p-3 max-[680px]:mb-3 max-[680px]:min-h-[67px] max-[680px]:p-[9px]">
            <div className="flex flex-none items-center">
              <TokenMark symbol={token0.symbol} className={`${MARK_SMALL} ${MARK_AMBER}`} />
              <TokenMark symbol={token1.symbol} className={`${MARK_SMALL} ${MARK_BLUE} -ml-[7px]`} />
            </div>
            <div className="grid min-w-0 gap-0.5">
              <strong className="overflow-hidden text-[.96rem] font-semibold text-ellipsis whitespace-nowrap text-[#f3f4f6]">{token0.symbol} / {token1.symbol}</strong>
              <span className="text-[.78rem] text-[#b6c1d1]">{feeTier} trading fee</span>
            </div>
            {!initialPoolAddress && !isCanonical && (discovery?.pools.length ?? 0) > 1 ? (
              <label className="relative ml-auto flex w-[min(45%,190px)] items-center text-[#b6c1d1] [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:right-2">
                <span className="sr-only">Select pool</span>
                <select
                  aria-label="Select pool"
                  className="min-h-9 w-full min-w-0 appearance-none rounded-[7px] border border-[#344256] bg-[#0f1724] py-[5px] pr-[29px] pl-2 text-[.75rem] text-[#e2e8f0]"
                  value={activeCustomPool?.address ?? ""}
                  onChange={(e) => handleSelectPool(e.target.value)}
                >
                  {discovery?.pools.map((pool) => (
                    <option key={pool.address} value={pool.address}>
                      {formatFeeTier(pool.fee)} fee · {pool.address.slice(0, 6)}…{pool.address.slice(-4)}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={16} aria-hidden="true" />
              </label>
            ) : (
              <span className="ml-auto inline-flex min-h-[27px] items-center justify-center rounded-lg border-0 bg-[#064e3b] px-[9px] py-0.5 text-[.72rem] font-[550] whitespace-nowrap text-[#6ee7b7]">Selected</span>
            )}
          </div>

          <dl className="m-0">
            <div className={DETAIL_ROW}>
              <dt>You earn</dt>
              <dd className={DETAIL_VALUE}>{feeTier} of each trade</dd>
            </div>
            <div className={DETAIL_ROW}>
              <dt>{token0.symbol} price now</dt>
              <dd className={DETAIL_VALUE}>${formatPoolPrice(spotPrice)}</dd>
            </div>
            <div className={DETAIL_ROW}>
              <dt>Network</dt>
              <dd className={DETAIL_VALUE}>Arc Mainnet · Uniswap {v4Pool ? "v4" : "v3"}</dd>
            </div>
          </dl>
        </section>

        <section className="min-w-0 border-l border-[#344256] px-[22px] max-[1180px]:[grid-area:range] max-[680px]:border-t max-[680px]:border-l-0 max-[680px]:px-0 max-[680px]:pt-[19px]" aria-labelledby="range-heading">
          <header className={STATION_HEADING}>
            <h2 id="range-heading">2. Choose your price range</h2>
            <p>You only earn while the {token0.symbol} price stays inside this range. Wider keeps earning through bigger moves; narrower earns more per trade but pauses sooner.</p>
          </header>

          <MeteoraRangeBar
            minPrice={minPrice}
            maxPrice={maxPrice}
            spotPrice={spotPrice}
            token0Symbol={token0.symbol}
            token1Symbol={token1.symbol}
          />
          <p className="mx-0.5 -mt-3 mb-3 text-center text-[.75rem] text-[#8190a5]">Illustrative shape, not real pool depth</p>

          <StrategyCards
            selected={strategy}
            spotPrice={spotPrice}
            onSelect={handleStrategy}
          />

          <div className="mt-4 rounded-[9px] border border-[#29364a] bg-[#111827]">
            <button
              type="button"
              aria-expanded={showProDrawer}
              onClick={() => setShowProDrawer(!showProDrawer)}
              className="flex min-h-[41px] w-full cursor-pointer items-center justify-between gap-3 rounded-[inherit] border-0 bg-transparent px-[11px] py-2 text-left text-[.8rem] text-[#dce5f2] hover:bg-[#151e2b]"
            >
              <span className="inline-flex items-center gap-2"><IconSliders size={16} /> Technical details</span>
              {showProDrawer ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
            </button>
            {showProDrawer ? (
              <div className="grid grid-cols-2 gap-2.5 px-[11px] pt-0.5 pb-3">
                <div className={PRO_ITEM}><span>Lower tick</span><strong>{tickLower}</strong></div>
                <div className={PRO_ITEM}><span>Upper tick</span><strong>{tickUpper}</strong></div>
                <div className={PRO_ITEM}><span>Tick spacing</span><strong>{tickSpacing}</strong></div>
                <div className={PRO_ITEM}><span>Pool</span><strong>{poolAddress ? `${poolAddress.slice(0, 8)}…${poolAddress.slice(-6)}` : "—"}</strong></div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="min-w-0 border-l border-[#344256] pl-[22px] max-[1180px]:border-t max-[1180px]:border-l-0 max-[1180px]:px-0 max-[1180px]:pt-[22px] max-[1180px]:pb-0 max-[1180px]:[grid-area:amounts] max-[680px]:pt-[19px]" aria-labelledby="amounts-heading">
          <header className={STATION_HEADING}>
            <h2 id="amounts-heading">3. How much to add</h2>
            <p>Type either amount. The other fills in so both match your range.</p>
          </header>

          <form onSubmit={handleReview} className="grid gap-3 max-[1180px]:grid-cols-2 max-[1180px]:items-start max-[680px]:grid-cols-[minmax(0,1fr)] max-[680px]:gap-[9px]">
            {[
              { id: "token0-amount", side: "token0" as const, isToken: true, symbol: token0.symbol, value: amount0, onChange: handleAmount0Change,
                balance: balance0, short: short0, usd: (Number.parseFloat(amount0.trim().replace(",", ".")) || 0) * spotPrice },
              { id: "token1-amount", side: "token1" as const, isToken: false, symbol: token1.symbol, value: amount1, onChange: handleAmount1Change,
                balance: balance1, short: short1, usd: Number.parseFloat(amount1.trim().replace(",", ".")) || 0 },
            ].map((field) => (
              <div className="min-w-0 rounded-[10px] border border-[#29364a] bg-[#151e2b] px-3 pt-[11px] pb-[7px]" key={field.id}>
                <div className="flex min-h-[38px] min-w-0 items-center gap-2">
                  <div className="mr-auto flex min-w-0 items-center gap-[9px]">
                    <TokenMark symbol={field.symbol} className={`${MARK_REGULAR} ${MARK_DEFAULT}`} />
                    <strong className="overflow-hidden text-[.98rem] font-semibold text-ellipsis text-[#f3f4f6]">{field.symbol}</strong>
                  </div>
                  {wallet ? <span className="overflow-hidden text-[.78rem] text-ellipsis whitespace-nowrap text-[#b6c1d1] tabular-nums max-[390px]:max-w-[88px] max-[390px]:text-[.68rem]">You have {field.balance}</span> : null}
                </div>
                <div className="mt-[7px] flex min-h-[52px] items-center gap-2.5 rounded-lg border border-[#344256] bg-[#0f1724] px-[11px] focus-within:border-[#10b981] focus-within:shadow-[0_0_0_1px_#10b981]">
                  <label className="sr-only" htmlFor={field.id}>{field.symbol} amount</label>
                  <input
                    id={field.id}
                    className="min-h-12 w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-[1.25rem] text-[#f3f4f6] tabular-nums shadow-none placeholder:text-[#8493a8] placeholder:opacity-100 focus:border-0 focus:shadow-none aria-invalid:text-[#fcd34d]"
                    type="text"
                    inputMode="decimal"
                    value={field.value}
                    onChange={(e) => { field.onChange(e.target.value); setReviewing(false); }}
                    placeholder="0.0"
                    aria-invalid={field.short || undefined}
                  />
                  <span className="text-[.85rem] whitespace-nowrap text-[#b6c1d1]">{field.symbol}</span>
                </div>
                {wallet ? (
                  <div className="mt-2 grid grid-cols-4 gap-1.5" role="group" aria-label={`Use part of your ${field.symbol} balance`}>
                    {AMOUNT_PERCENTS.map((percent) => {
                      const value = percentOfBalance(field.side, percent);
                      return (
                        <button
                          key={percent}
                          type="button"
                          disabled={!value}
                          className="min-h-8 cursor-pointer rounded-[7px] border border-[#344256] bg-[#151e2b] text-[.75rem] font-semibold text-[#dce5f2] enabled:hover:border-[#53647a] enabled:hover:bg-[#1a2635] disabled:cursor-not-allowed disabled:opacity-45"
                          onClick={() => { field.onChange(value); setReviewing(false); }}
                        >
                          {percent === 100 ? "Max" : `${percent}%`}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <p className="mt-1 mb-0 min-h-[21px] text-[.82rem] text-[#b6c1d1] tabular-nums">≈ {formatCurrency(field.usd)}</p>
                {field.short ? (
                  <p className="mt-2 mb-0 text-[.78rem] leading-[1.45] text-[#fcd34d]" role="alert">
                    Not enough {field.symbol} in your Actora wallet.
                    {field.isToken && onNeedTokens
                      ? <> <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-[#10b981] underline underline-offset-2" onClick={onNeedTokens}>Buy {token0.symbol} with USDC</button></>
                      : " Add USDC to your Actora wallet first."}
                  </p>
                ) : null}
              </div>
            ))}

            {!wallet ? (
              <button
                type="button"
                className={`${PRIMARY_ACTION} max-[1180px]:col-span-full max-[680px]:col-auto`}
                onClick={() => {
                  if (onOpenAuth) onOpenAuth();
                  else open();
                }}
              >
                <IconWallet size={18} />
                <span>{isConnected ? "Sign in to add liquidity" : "Connect wallet to add liquidity"}</span>
              </button>
            ) : !reviewing ? (
              <button
                type="submit"
                className={`${PRIMARY_ACTION} max-[1180px]:col-span-full max-[680px]:col-auto`}
                disabled={!hasAmounts || !!short0 || !!short1 || (!v4Pool && !isCanonical && !activeCustomPool)}
              >
                Review position
              </button>
            ) : null}
          </form>

          {wallet && reviewing ? (
            <PositionReview
              tokenSymbol={token0.symbol}
              amountToken={amount0}
              amountUsdc={amount1}
              valueUsd={(Number.parseFloat(amount0) || 0) * spotPrice + (Number.parseFloat(amount1) || 0)}
              minPrice={minPrice}
              maxPrice={maxPrice}
              feeLabel={feeTier}
              steps={[
                ...approvals.map(({ symbol }) => v4Pool
                  ? `Allow Uniswap to use your ${symbol} (skipped if already allowed)`
                  : `Allow Uniswap to use your ${symbol}`),
                "Open the position",
              ]}
              maxTransactions={approvals.length * (v4Pool ? 2 : 1) + 1}
              progress={progress}
              busy={executing}
              onConfirm={handleConfirm}
              onEdit={() => setReviewing(false)}
            />
          ) : null}
        </section>
      </div>

      <footer className="mt-7 -mx-[clamp(18px,3.2vw,52px)] mb-0 grid grid-cols-4 border-y border-[#263243] bg-[#0d131f] px-[clamp(18px,3.2vw,52px)] py-4 max-[680px]:mx-[-16px] max-[680px]:mt-[23px] max-[680px]:mb-[-30px] max-[680px]:grid-cols-2 max-[680px]:gap-x-0 max-[680px]:gap-y-[13px] max-[680px]:px-4 max-[680px]:py-3.5" aria-label="Selected liquidity range summary">
        <div className={SUMMARY_ITEM}><span>{token0.symbol} price now</span><strong>${formatPoolPrice(spotPrice)}</strong></div>
        <div className={SUMMARY_ITEM}><span>Earning range</span><strong>${formatPoolPrice(minPrice)} – ${formatPoolPrice(maxPrice)}</strong></div>
        <div className={SUMMARY_ITEM}><span>Range width</span><strong>{rangeWidth}</strong></div>
        <div className={SUMMARY_ITEM}><span>Trading fee</span><strong>{feeTier}</strong></div>
      </footer>
    </div>
  );
};
