import React, { useState, useMemo, useEffect } from "react";
import { formatUnits, getAddress, parseUnits, zeroAddress } from "viem";
import { useAccount } from "wagmi";
import {
  ALPHA_POOL,
  type AlphaWalletSummary,
  type DiscoveredPool,
} from "@stillwater/chain";
import { useAppKit } from "@reown/appkit/react";
import { api, type ManagedWalletRecord, type PublicPool, type TokenPoolDiscovery } from "../lib/api-client";
import { alignTick, pairedAmount, priceToTick, tickToPrice } from "../lib/range-math";
import { ensureV4Allowance, v4MintApprovals } from "../lib/v4-actions";
import { KoiBand } from "../components/pond/KoiBand";
import { PositionReview, PRIMARY_ACTION } from "../components/PositionReview";
import { STRATEGIES, StrategyCards, type StrategyKey } from "../components/StrategyCards";
import { formatFeeTier, formatPoolPrice } from "./ExplorePage";
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

function tokenMarkText(symbol: string): string {
  return symbol === "cirBTC" ? "cB" : symbol.slice(0, 2).toUpperCase();
}

const MARK_REGULAR = "inline-grid size-10 text-[.65rem]";
const MARK_DEFAULT = "border-line-strong bg-card text-ink";
const PRO_ITEM = "grid min-w-0 gap-0.5 text-[.72rem] text-ink-muted [&_strong]:overflow-hidden [&_strong]:font-mono [&_strong]:text-[.73rem] [&_strong]:font-medium [&_strong]:text-ellipsis [&_strong]:text-ink";
const DISCOVERY_STATE = "mx-0.5 mt-2 mb-0 text-[0.8125rem]";

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
    if (!wallet && pool) {
      // Signed out: the public pool record is enough to show the form; balances are zero.
      const usdc = { address: ALPHA_POOL.token1.address, symbol: "USDC", decimals: 6, balance: "0" };
      const token = { address: getAddress(pool.token.address), symbol: pool.token.symbol, decimals: pool.token.decimals, balance: "0" };
      const [first, second] = pool.token0.toLowerCase() === token.address.toLowerCase() ? [token, usdc] : [usdc, token];
      setDiscovery({ token, usdc, liability: "0", pools: [{ address: getAddress(pool.address), token0: first, token1: second,
        fee: pool.fee, tickSpacing: pool.tickSpacing, sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, liquidity: pool.liquidity }] });
      setSelectedTokenAddress(initialTokenAddress);
      setSelectedPoolAddress(initialPoolAddress);
      setSearchQuery(initialTokenAddress);
      setDiscoveryError(null);
      return;
    }
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
  }, [initialPoolAddress, initialTokenAddress, v4Pool, wallet, pool]);

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
        setDiscoveryError(`No active ${res.token.symbol}/USDC pool found on Arc.`);
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
        ? "This pool can't accept new positions through Stillwater right now. Nothing was sent." : msg);
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

  const approvals = reviewing ? approvalsNeeded() : [];

  if (initialPoolAddress && !v4Pool && !isCanonical && !activeCustomPool) {
    return <p className={`${DISCOVERY_STATE} ${discoveryError ? "text-danger" : "text-link"}`} role={discoveryError ? "alert" : "status"}>
      {discoveryError ?? "Loading selected pool and range…"}</p>;
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] text-ink">
      {!initialPoolAddress ? <div className="min-h-[62px] max-[680px]:min-h-[54px]">
        <div className="flex min-h-[60px] items-center gap-3.5 rounded-[10px] border border-line-strong bg-field px-[17px] text-ink-muted focus-within:border-accent focus-within:ring-1 focus-within:ring-accent max-[680px]:min-h-[52px] max-[680px]:gap-2.5 max-[680px]:px-3 [&>svg]:flex-none [&>svg]:text-ink-muted">
          <IconSearch size={20} aria-hidden="true" />
          <label className="sr-only" htmlFor="token-search">Paste an Arc token contract address</label>
          <input
            id="token-search"
            className="min-h-14 w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-[1.05rem] text-ink shadow-none placeholder:text-ink-muted placeholder:opacity-100 focus:border-0 focus:shadow-none max-[680px]:min-h-12 max-[680px]:text-[.9rem]"
            type="text"
            value={searchQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Paste an Arc token contract address…"
            autoComplete="off"
            spellCheck={false}
          />
          {searchQuery ? (
            <button
              type="button"
              className="inline-grid size-[34px] flex-none cursor-pointer place-items-center border-0 border-l border-line-strong bg-transparent text-ink-muted"
              aria-label="Clear token search"
              onClick={() => setSearchQuery("")}
            >
              <IconClose size={16} />
            </button>
          ) : null}
        </div>
        {discovering ? (
          <p className={`${DISCOVERY_STATE} text-link`} role="status">Checking Arc for token details and active pools…</p>
        ) : discoveryError ? (
          <p className={`${DISCOVERY_STATE} text-danger`} role="alert">{discoveryError}</p>
        ) : null}
      </div> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,420px)] items-start gap-[clamp(24px,3vw,40px)] max-[1040px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-7">
          <section aria-labelledby="band-heading" className="flex flex-col gap-5 rounded-[32px] bg-sage px-[clamp(20px,3.2vw,40px)] py-8">
            <div className="flex flex-col gap-2">
              <h2 id="band-heading" className="text-[2rem] font-semibold">Choose your band</h2>
              <p className="max-w-[62ch] text-[1.05rem] leading-relaxed text-ink-muted">
                You only earn while the {token0.symbol} price stays inside your band. A wider band keeps earning through bigger moves; a narrower one earns more per trade but rests sooner.
              </p>
            </div>
            <StrategyCards selected={strategy} spotPrice={spotPrice} onSelect={handleStrategy} />
            <KoiBand min={minPrice} max={maxPrice} price={spotPrice} size="small"
              labels={{ min: `rests below $${formatPoolPrice(minPrice)}`, max: `rests above $${formatPoolPrice(maxPrice)}` }} />
            <p className="font-hand text-[1.75rem] leading-snug text-hand">you earn while {token0.symbol}&apos;s price stays between these two.</p>
            <div className="rounded-[18px] border border-line bg-card">
              <button type="button" aria-expanded={showProDrawer} onClick={() => setShowProDrawer(!showProDrawer)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-[inherit] px-4 text-left text-[1rem] text-ink hover:bg-tint">
                <span className="inline-flex items-center gap-2"><IconSliders size={16} /> Technical details</span>
                {showProDrawer ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
              </button>
              {showProDrawer ? (
                <div className="grid grid-cols-2 gap-3 px-4 pt-1 pb-4">
                  <div className={PRO_ITEM}><span>Lower tick</span><strong>{tickLower}</strong></div>
                  <div className={PRO_ITEM}><span>Upper tick</span><strong>{tickUpper}</strong></div>
                  <div className={PRO_ITEM}><span>Tick spacing</span><strong>{tickSpacing}</strong></div>
                  <div className={PRO_ITEM}><span>Pool</span><strong>{poolAddress ? `${poolAddress.slice(0, 8)}…${poolAddress.slice(-6)}` : "—"}</strong></div>
                </div>
              ) : null}
            </div>
          </section>

          <section aria-labelledby="amounts-heading" className="flex flex-col gap-5 rounded-[28px] border border-line bg-card px-[clamp(20px,3.2vw,40px)] py-8">
            <div className="flex flex-col gap-2">
              <h2 id="amounts-heading" className="text-[2rem] font-semibold">How much to add</h2>
              <p className="text-[1.05rem] text-ink-muted">Type either amount. The other fills in so both match your band.</p>
            </div>
            <form id="deposit-form" onSubmit={handleReview} className="grid grid-cols-2 items-start gap-5 max-[680px]:grid-cols-1">
              {[
                { id: "token0-amount", side: "token0" as const, isToken: true, symbol: token0.symbol, value: amount0, onChange: handleAmount0Change,
                  balance: balance0, short: short0, usd: (Number.parseFloat(amount0.trim().replace(",", ".")) || 0) * spotPrice },
                { id: "token1-amount", side: "token1" as const, isToken: false, symbol: token1.symbol, value: amount1, onChange: handleAmount1Change,
                  balance: balance1, short: short1, usd: Number.parseFloat(amount1.trim().replace(",", ".")) || 0 },
              ].map((field) => (
                <div className="flex min-w-0 flex-col gap-2.5" key={field.id}>
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <label htmlFor={field.id} className="flex min-w-0 items-center gap-2.5 text-[1.05rem] font-semibold">
                      <TokenMark symbol={field.symbol} className={`${MARK_REGULAR} ${MARK_DEFAULT}`} />
                      <span className="overflow-hidden text-ellipsis">{field.symbol}</span>
                    </label>
                    {wallet ? <span className="overflow-hidden text-[.95rem] text-ellipsis whitespace-nowrap text-ink-muted tabular-nums">You have {field.balance}</span> : null}
                  </div>
                  <input
                    id={field.id}
                    name={field.id}
                    autoComplete="off"
                    className="min-h-16 w-full min-w-0 rounded-[18px] border border-line bg-field px-5 text-[1.5rem] text-ink tabular-nums aria-invalid:border-rest-line aria-invalid:text-rest"
                    type="text"
                    inputMode="decimal"
                    value={field.value}
                    onChange={(e) => { field.onChange(e.target.value); setReviewing(false); }}
                    placeholder="0.0"
                    aria-invalid={field.short || undefined}
                  />
                  {wallet ? (
                    <div className="grid grid-cols-4 gap-2" role="group" aria-label={`Use part of your ${field.symbol} balance`}>
                      {AMOUNT_PERCENTS.map((percent) => {
                        const value = percentOfBalance(field.side, percent);
                        return (
                          <button key={percent} type="button" disabled={!value}
                            className="min-h-11 rounded-full border border-line text-[.95rem] font-medium text-ink enabled:hover:bg-tint disabled:cursor-not-allowed disabled:opacity-45"
                            onClick={() => { field.onChange(value); setReviewing(false); }}>
                            {percent === 100 ? "Max" : `${percent}%`}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  <p className="text-[.95rem] text-ink-muted tabular-nums">≈ {formatCurrency(field.usd)}</p>
                  {field.short ? (
                    <p className="text-[.95rem] leading-relaxed text-rest" role="alert">
                      Not enough {field.symbol} in your Stillwater wallet.
                      {field.isToken && onNeedTokens
                        ? <> <button type="button" className="font-semibold text-link underline underline-offset-2" onClick={onNeedTokens}>Buy {token0.symbol} with USDC</button></>
                        : " Add USDC to your Stillwater wallet first."}
                    </p>
                  ) : null}
                </div>
              ))}
            </form>
          </section>
        </div>

        <aside aria-labelledby="new-pond-heading" className="flex flex-col gap-5 rounded-[28px] border border-line bg-card p-[clamp(20px,2.6vw,32px)] min-[1041px]:sticky min-[1041px]:top-28">
          <h2 id="new-pond-heading" className="text-[1.85rem] font-semibold">Your new pond</h2>
          <dl className="flex flex-col">
            {[
              { label: "You add", value: `≈ ${formatCurrency((Number.parseFloat(amount0) || 0) * spotPrice + (Number.parseFloat(amount1) || 0))}` },
              { label: `Earns while ${token0.symbol} is`, value: `$${formatPoolPrice(minPrice)} – $${formatPoolPrice(maxPrice)}` },
              { label: "Band width", value: rangeWidth },
              { label: "Pool fee", value: poolFee === 0x800000 ? "Varies per trade" : feeTier },
              { label: `${token0.symbol} now`, value: `$${formatPoolPrice(spotPrice)}` },
            ].map((row) => (
              <div key={row.label} className="flex justify-between gap-4 border-t border-line py-3.5 text-[1.05rem]">
                <dt className="text-ink-muted">{row.label}</dt>
                <dd className="text-right font-medium tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
          {!wallet ? (
            <button type="button" className={PRIMARY_ACTION} onClick={() => { if (onOpenAuth) onOpenAuth(); else open(); }}>
              <IconWallet size={18} />
              <span>{isConnected ? "Sign in to add liquidity" : "Connect wallet to add liquidity"}</span>
            </button>
          ) : !reviewing ? (
            <button type="submit" form="deposit-form" className={PRIMARY_ACTION}
              disabled={!hasAmounts || !!short0 || !!short1 || (!v4Pool && !isCanonical && !activeCustomPool)}>
              Review pond
            </button>
          ) : null}
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
                "Open the pond",
              ]}
              maxTransactions={approvals.length * (v4Pool ? 2 : 1) + 1}
              progress={progress}
              busy={executing}
              onConfirm={handleConfirm}
              onEdit={() => setReviewing(false)}
            />
          ) : (
            <p className="text-[.95rem] leading-relaxed text-ink-muted">Stillwater checks each step again before sending it. Nothing is sent until you confirm.</p>
          )}
          {poolAddress ? (
            <a className="inline-flex min-h-11 items-center gap-2 self-start text-[.95rem] font-medium text-link"
              href={`https://explorer.arc.io/address/${poolAddress}`} target="_blank" rel="noreferrer">
              View the pool on Arc&apos;s explorer <IconExternalLink size={14} />
            </a>
          ) : null}
        </aside>
      </div>
    </div>
  );
};
