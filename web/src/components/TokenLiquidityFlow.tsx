import React, { useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import type { DiscoveredPool } from "@actora/chain";
import { api, ApiError, type ManagedWalletRecord, type TokenPoolDiscovery } from "../lib/api-client";

type Props = {
  wallet: ManagedWalletRecord | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
};

type PreparedApproval = {
  kind: "token" | "usdc";
  intentId: string;
  amount: string;
  gasEstimate: string;
};

type PreparedMint = {
  intentId: string;
  tokenId: string;
  liquidity: string;
  amount0: string;
  amount1: string;
  gasEstimate: string;
};

function parseHumanUnits(value: string, decimals: number, label: string): string {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Enter a valid ${label} amount.`);
  }
  try {
    const raw = parseUnits(trimmed, decimals);
    if (raw <= 0n) throw new Error(`${label} amount must be greater than zero.`);
    return raw.toString();
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be greater")) throw error;
    throw new Error(`${label} exceeds ${decimals} decimal places.`);
  }
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function formatRaw(raw: string | undefined, decimals: number): string {
  if (!raw) return "—";
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return "—";
  }
}

function alignTick(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

function liabilityMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "TOKEN_NOT_FOUND") return "That address has no usable contract bytecode on Arc.";
    if (error.code === "POOL_DISCOVERY_FAILED") return "Arc could not verify the token right now. Try again shortly.";
    if (error.code === "POOL_NOT_ALLOWED") return "That pool is not one of the canonical initialized pools returned for this token.";
    if (error.code === "MAINNET_EXECUTION_DISABLED") return "Execution is disabled in this environment; simulation is still available.";
    return error.code.replaceAll("_", " ").toLowerCase();
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export const TokenLiquidityFlow: React.FC<Props> = ({ wallet, onRefresh, onNotify }) => {
  const [tokenAddress, setTokenAddress] = useState("");
  const [discovery, setDiscovery] = useState<TokenPoolDiscovery | null>(null);
  const [selectedPoolAddress, setSelectedPoolAddress] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenAmount, setTokenAmount] = useState("");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [tickLower, setTickLower] = useState("");
  const [tickUpper, setTickUpper] = useState("");
  const [preparingApproval, setPreparingApproval] = useState<"token" | "usdc" | null>(null);
  const [preparedApproval, setPreparedApproval] = useState<PreparedApproval | null>(null);
  const [preparedMint, setPreparedMint] = useState<PreparedMint | null>(null);
  const [executing, setExecuting] = useState(false);

  const selectedPool = useMemo<DiscoveredPool | undefined>(
    () => discovery?.pools.find((pool) => pool.address === selectedPoolAddress),
    [discovery, selectedPoolAddress],
  );
  const token = discovery?.token;
  const usdc = discovery?.usdc;
  const hasWallet = wallet?.state === "active";

  const setPool = (pool: DiscoveredPool) => {
    setSelectedPoolAddress(pool.address);
    const spacing = pool.tickSpacing;
    const center = alignTick(pool.tick, spacing);
    setTickLower(String(center - spacing * 20));
    setTickUpper(String(center + spacing * 20));
    setPreparedApproval(null);
    setPreparedMint(null);
  };

  const handleDiscover = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = tokenAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      setError("Paste a valid 42-character Arc contract address.");
      return;
    }
    setDiscovering(true);
    setError(null);
    setDiscovery(null);
    setPreparedApproval(null);
    setPreparedMint(null);
    try {
      const result = await api.discoverTokenPools(value);
      setDiscovery(result);
      if (result.pools.length === 0) {
        setError("No supported initialized token / USDC pool was found on Arc.");
        return;
      }
      setPool(result.pools[0]);
      setTokenAmount("");
      setUsdcAmount("");
      onNotify("success", "Pool found", `${result.token.symbol} is ready to configure.`);
    } catch (caught) {
      setError(liabilityMessage(caught));
      onNotify("error", "Token check failed", liabilityMessage(caught));
    } finally {
      setDiscovering(false);
    }
  };

  const refreshDiscovery = async () => {
    if (!tokenAddress.trim()) return;
    try {
      const result = await api.discoverTokenPools(tokenAddress.trim());
      setDiscovery(result);
      if (!result.pools.some((pool) => pool.address === selectedPoolAddress)) {
        if (result.pools[0]) setPool(result.pools[0]);
      }
    } catch {
      // The transaction result is already known; a follow-up balance refresh is best effort.
    }
  };

  const executeAndWait = async (intentId: string): Promise<boolean> => {
    const result = await api.executeIntent(intentId);
    onNotify("info", "Transaction broadcast", `${result.transactionHash.slice(0, 10)}… is being finalized on Arc.`);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const receipt = await api.reconcileAttempt(result.attemptId);
        if (receipt.status === "confirmed") {
          onNotify("success", "Transaction confirmed", `Confirmed in block ${receipt.blockNumber ?? "on Arc"}.`);
          return true;
        }
        if (["reverted", "broadcast_failed", "nonce_conflict"].includes(receipt.status)) {
          throw new Error(receipt.reasonCode.replaceAll("_", " ").toLowerCase());
        }
      } catch (caught) {
        if (attempt === 5) throw caught;
      }
    }
    onNotify("info", "Still finalizing", "The transaction remains tracked by Actora and will reconcile in the background.");
    return false;
  };

  const handlePrepareApproval = async (kind: "token" | "usdc") => {
    if (!selectedPool || !token || !usdc) return;
    setPreparingApproval(kind);
    setError(null);
    try {
      const decimals = kind === "token" ? token.decimals : usdc.decimals;
      const label = kind === "token" ? token.symbol : "USDC";
      const amount = parseHumanUnits(kind === "token" ? tokenAmount : usdcAmount, decimals, label);
      const result = await api.prepareTokenApproval({
        tokenAddress: token.address,
        poolAddress: selectedPool.address,
        amount,
        idempotencyKey: crypto.randomUUID(),
      });
      setPreparedApproval({ kind, intentId: result.intentId, amount, gasEstimate: result.simulation.gasEstimate });
      onNotify("info", `${label} approval simulated`, `${result.simulation.gasEstimate} gas units estimated.`);
    } catch (caught) {
      setError(liabilityMessage(caught));
      onNotify("error", "Approval simulation failed", liabilityMessage(caught));
    } finally {
      setPreparingApproval(null);
    }
  };

  const handleExecuteApproval = async () => {
    if (!preparedApproval || !token || !usdc) return;
    setExecuting(true);
    try {
      if (await executeAndWait(preparedApproval.intentId)) {
        const label = preparedApproval.kind === "token" ? token.symbol : "USDC";
        onNotify("success", `${label} approved`, "The managed wallet can now use this exact amount for the selected pool.");
        setPreparedApproval(null);
        await Promise.all([onRefresh(), refreshDiscovery()]);
      }
    } catch (caught) {
      setError(liabilityMessage(caught));
      onNotify("error", "Approval execution failed", liabilityMessage(caught));
    } finally {
      setExecuting(false);
    }
  };

  const handlePrepareMint = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedPool || !token || !usdc) return;
    setError(null);
    try {
      const rawToken = parseHumanUnits(tokenAmount, token.decimals, token.symbol);
      const rawUsdc = parseHumanUnits(usdcAmount, usdc.decimals, "USDC");
      const lower = Number(tickLower);
      const upper = Number(tickUpper);
      if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower >= upper) {
        throw new Error("Enter a valid lower and upper tick.");
      }
      if (lower % selectedPool.tickSpacing !== 0 || upper % selectedPool.tickSpacing !== 0) {
        throw new Error(`Ticks must be aligned to spacing ${selectedPool.tickSpacing}.`);
      }
      setExecuting(true);
      const result = await api.prepareTokenMint({
        tokenAddress: token.address,
        poolAddress: selectedPool.address,
        tickLower: lower,
        tickUpper: upper,
        amountToken: rawToken,
        amountUsdc: rawUsdc,
        slippageBps: 100,
        deadline: String(Math.floor(Date.now() / 1000) + 1800),
        idempotencyKey: crypto.randomUUID(),
      });
      setPreparedMint({
        intentId: result.intentId,
        tokenId: result.simulation.tokenId,
        liquidity: result.simulation.liquidity,
        amount0: result.simulation.amount0,
        amount1: result.simulation.amount1,
        gasEstimate: result.simulation.gasEstimate,
      });
      onNotify("info", "Liquidity simulated", `Position NFT #${result.simulation.tokenId} is ready for review.`);
    } catch (caught) {
      setError(liabilityMessage(caught));
      onNotify("error", "Liquidity simulation failed", liabilityMessage(caught));
    } finally {
      setExecuting(false);
    }
  };

  const handleExecuteMint = async () => {
    if (!preparedMint) return;
    setExecuting(true);
    try {
      if (await executeAndWait(preparedMint.intentId)) {
        onNotify("success", "Liquidity position opened", `Position NFT #${preparedMint.tokenId} is now managed by Actora.`);
        setPreparedMint(null);
        await Promise.all([onRefresh(), refreshDiscovery()]);
      }
    } catch (caught) {
      setError(liabilityMessage(caught));
      onNotify("error", "Mint execution failed", liabilityMessage(caught));
    } finally {
      setExecuting(false);
    }
  };

  const tokenFirst = selectedPool?.token0.address === token?.address;
  const simulatedTokenAmount = preparedMint
    ? formatRaw(tokenFirst ? preparedMint.amount0 : preparedMint.amount1, token?.decimals ?? 18)
    : null;
  const simulatedUsdcAmount = preparedMint
    ? formatRaw(tokenFirst ? preparedMint.amount1 : preparedMint.amount0, usdc?.decimals ?? 6)
    : null;

  return (
    <section className="mb-6 overflow-hidden rounded-3xl border border-cyan-400/15 bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
      <div className="border-b border-white/10 bg-[radial-gradient(circle_at_88%_12%,rgba(6,182,212,0.16),transparent_36%),linear-gradient(120deg,rgba(17,20,25,1),rgba(12,25,28,0.9))] p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-2xl">
            <p className="mb-3 text-[11px] font-semibold tracking-[0.18em] text-cyan-300/80">LIQUIDITY STUDIO</p>
            <h2 className="text-2xl font-semibold tracking-[-0.03em] text-slate-50 sm:text-3xl">Bring an Arc token into a live pool.</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">
              Paste a contract address. Actora checks compatibility, shows the initialized Uniswap pools it can use, and keeps the final approval and mint under the same signer safeguards as the alpha pool.
            </p>
          </div>
          <div className="min-w-[210px] rounded-2xl border border-cyan-300/15 bg-black/15 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-cyan-200">
              <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(103,232,249,0.75)]" />
              Compatibility lane
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">Existing pools only. No pool creation, swaps, or token safety endorsement.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(260px,0.85fr)]">
        <div>
          <form onSubmit={handleDiscover}>
            <label htmlFor="token-address" className="text-sm font-semibold text-slate-100">Token contract address</label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="token-address"
                value={tokenAddress}
                onChange={(event) => setTokenAddress(event.target.value)}
                placeholder="0x… paste an Arc ERC-20 contract"
                spellCheck={false}
                autoComplete="off"
                disabled={!hasWallet || discovering}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-surface px-4 py-3 font-mono text-sm text-slate-100 placeholder:text-slate-500 transition-[border-color,box-shadow] focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15"
              />
              <button
                type="submit"
                disabled={!hasWallet || discovering || tokenAddress.trim().length === 0}
                className="rounded-xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition-[background-color,transform,opacity] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-cyan-200 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {discovering ? "Checking…" : "Find pools"}
              </button>
            </div>
            {!wallet ? <p className="mt-2 text-xs text-amber-300">Provision the managed wallet above before searching for a pool.</p> : null}
          </form>

          {error ? (
            <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3.5 text-sm text-amber-100">
              <span aria-hidden="true" className="mt-0.5 text-amber-300">!</span>
              <span>{error}</span>
            </div>
          ) : null}

          {discovery && token ? (
            <div aria-live="polite" className="mt-6 space-y-5">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 pb-4">
                <div>
                  <p className="text-xs text-slate-400">Detected token</p>
                  <div className="mt-1 flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-slate-100">{token.symbol}</h3>
                    <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-medium text-cyan-200">{token.decimals} decimals</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">{shortAddress(token.address)}</p>
                </div>
                <div className="text-right text-xs text-slate-400">
                  <div>Wallet balance</div>
                  <div className="mt-1 font-mono text-sm text-slate-200">{formatRaw(token.balance, token.decimals)} {token.symbol}</div>
                </div>
              </div>

              {discovery.pools.length > 0 ? (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <label className="text-sm font-semibold text-slate-100">Choose an initialized pool</label>
                    <span className="text-xs text-slate-500">{discovery.pools.length} found</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {discovery.pools.map((pool) => {
                      const selected = pool.address === selectedPoolAddress;
                      return (
                        <button
                          key={pool.address}
                          type="button"
                          onClick={() => setPool(pool)}
                          aria-pressed={selected}
                          className={`rounded-2xl border p-4 text-left transition-[border-color,background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.98] ${selected ? "border-cyan-300/70 bg-cyan-300/10" : "border-white/10 bg-surface/50 hover:border-white/25 hover:bg-surface"}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-semibold text-slate-100">{pool.fee / 10000}% fee</span>
                            <span className={`h-2 w-2 rounded-full ${selected ? "bg-cyan-300" : "bg-slate-600"}`} />
                          </div>
                          <div className="mt-2 text-xs text-slate-400">Tick spacing {pool.tickSpacing} · current tick {pool.tick}</div>
                          <div className="mt-2 font-mono text-[11px] text-slate-500">{shortAddress(pool.address)}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {selectedPool && usdc ? (
                <form onSubmit={handlePrepareMint} className="space-y-5 rounded-2xl border border-white/10 bg-surface/35 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">Configure liquidity</h3>
                      <p className="mt-1 text-xs text-slate-400">Amounts are paired against the selected range and simulated before signing.</p>
                    </div>
                    <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">Ready to simulate</span>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="flex items-center justify-between text-xs font-semibold text-slate-300"><span>{token.symbol} amount</span><span className="font-mono text-[11px] font-normal text-slate-500">{formatRaw(token.balance, token.decimals)} available</span></span>
                      <input value={tokenAmount} onChange={(event) => setTokenAmount(event.target.value)} inputMode="decimal" placeholder="0.0" className="mt-2 w-full rounded-xl border border-white/10 bg-surface px-3.5 py-3 font-mono text-sm text-slate-100 placeholder:text-slate-600 transition-[border-color,box-shadow] focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15" />
                    </label>
                    <label className="block">
                      <span className="flex items-center justify-between text-xs font-semibold text-slate-300"><span>USDC amount</span><span className="font-mono text-[11px] font-normal text-slate-500">{formatRaw(usdc.balance, usdc.decimals)} available</span></span>
                      <input value={usdcAmount} onChange={(event) => setUsdcAmount(event.target.value)} inputMode="decimal" placeholder="0.0" className="mt-2 w-full rounded-xl border border-white/10 bg-surface px-3.5 py-3 font-mono text-sm text-slate-100 placeholder:text-slate-600 transition-[border-color,box-shadow] focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15" />
                    </label>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block"><span className="text-xs font-semibold text-slate-300">Lower tick</span><input value={tickLower} onChange={(event) => setTickLower(event.target.value)} inputMode="numeric" className="mt-2 w-full rounded-xl border border-white/10 bg-surface px-3.5 py-3 font-mono text-sm text-slate-100 transition-[border-color,box-shadow] focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15" /></label>
                    <label className="block"><span className="text-xs font-semibold text-slate-300">Upper tick</span><input value={tickUpper} onChange={(event) => setTickUpper(event.target.value)} inputMode="numeric" className="mt-2 w-full rounded-xl border border-white/10 bg-surface px-3.5 py-3 font-mono text-sm text-slate-100 transition-[border-color,box-shadow] focus:border-cyan-300/70 focus:ring-2 focus:ring-cyan-300/15" /></label>
                  </div>
                  <p className="text-[11px] leading-5 text-slate-500">Ticks must use spacing {selectedPool.tickSpacing}. The current pool tick is {selectedPool.tick}; the initial range is centered around it.</p>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <button type="button" onClick={() => handlePrepareApproval("token")} disabled={preparingApproval !== null || executing} className="rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-3 text-sm font-semibold text-cyan-100 transition-[background-color,border-color,transform,opacity] duration-150 active:scale-[0.96] hover:border-cyan-300/50 hover:bg-cyan-300/15 disabled:cursor-not-allowed disabled:opacity-40">{preparingApproval === "token" ? "Simulating approval…" : `Approve ${token.symbol}`}</button>
                    <button type="button" onClick={() => handlePrepareApproval("usdc")} disabled={preparingApproval !== null || executing} className="rounded-xl border border-white/15 bg-surface px-4 py-3 text-sm font-semibold text-slate-200 transition-[background-color,border-color,transform,opacity] duration-150 active:scale-[0.96] hover:border-white/30 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40">{preparingApproval === "usdc" ? "Simulating approval…" : "Approve USDC"}</button>
                  </div>
                  <button type="submit" disabled={executing || preparingApproval !== null} className="w-full rounded-xl bg-emerald-primary px-4 py-3 text-sm font-semibold text-emerald-950 transition-[background-color,transform,opacity] duration-150 active:scale-[0.96] hover:bg-emerald-hover disabled:cursor-not-allowed disabled:opacity-40">{executing ? "Simulating on Arc…" : "Simulate liquidity"}</button>
                </form>
              ) : null}

              {preparedApproval ? (
                <div className="rounded-2xl border border-cyan-300/25 bg-cyan-300/10 p-4" aria-live="polite">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="text-sm font-semibold text-cyan-100">Approval simulated</p><p className="mt-1 text-xs text-cyan-100/70">Exact amount: {formatRaw(preparedApproval.amount, preparedApproval.kind === "token" ? token.decimals : usdc?.decimals ?? 6)} {preparedApproval.kind === "token" ? token.symbol : "USDC"}</p></div>
                    <span className="font-mono text-xs text-cyan-100/80">{preparedApproval.gasEstimate} gas</span>
                  </div>
                  <div className="mt-4 flex gap-2"><button type="button" onClick={() => setPreparedApproval(null)} disabled={executing} className="flex-1 rounded-xl border border-white/15 bg-surface px-3 py-2.5 text-xs font-semibold text-slate-200 transition-[background-color,transform] duration-150 active:scale-[0.96] hover:bg-surface-hover">Edit</button><button type="button" onClick={handleExecuteApproval} disabled={executing} className="flex-1 rounded-xl bg-cyan-300 px-3 py-2.5 text-xs font-semibold text-slate-950 transition-[background-color,transform,opacity] duration-150 active:scale-[0.96] hover:bg-cyan-200 disabled:opacity-40">{executing ? "Submitting…" : "Execute approval"}</button></div>
                </div>
              ) : null}

              {preparedMint ? (
                <div className="rounded-2xl border border-emerald-300/25 bg-emerald-300/10 p-4" aria-live="polite">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-emerald-100">Liquidity simulated</p><p className="mt-1 text-xs text-emerald-100/70">Position NFT #{preparedMint.tokenId} · {preparedMint.liquidity} liquidity</p></div><span className="font-mono text-xs text-emerald-100/80">{preparedMint.gasEstimate} gas</span></div>
                  <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl border border-white/10 bg-black/10 p-3"><p className="text-[11px] text-slate-400">{token.symbol} consumed</p><p className="mt-1 font-mono text-sm text-slate-100">{simulatedTokenAmount}</p></div><div className="rounded-xl border border-white/10 bg-black/10 p-3"><p className="text-[11px] text-slate-400">USDC consumed</p><p className="mt-1 font-mono text-sm text-slate-100">{simulatedUsdcAmount}</p></div></div>
                  <div className="mt-4 flex gap-2"><button type="button" onClick={() => setPreparedMint(null)} disabled={executing} className="flex-1 rounded-xl border border-white/15 bg-surface px-3 py-2.5 text-xs font-semibold text-slate-200 transition-[background-color,transform] duration-150 active:scale-[0.96] hover:bg-surface-hover">Edit</button><button type="button" onClick={handleExecuteMint} disabled={executing} className="flex-1 rounded-xl bg-emerald-primary px-3 py-2.5 text-xs font-semibold text-emerald-950 transition-[background-color,transform,opacity] duration-150 active:scale-[0.96] hover:bg-emerald-hover disabled:opacity-40">{executing ? "Submitting…" : "Execute liquidity"}</button></div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <aside className="self-start rounded-2xl border border-white/10 bg-surface/35 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><span className="flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">i</span>What Actora checks</div>
          <ul className="mt-4 space-y-3 text-xs leading-5 text-slate-400">
            <li className="flex gap-2"><span className="text-cyan-300">•</span><span>Contract bytecode and usable ERC-20 reads.</span></li>
            <li className="flex gap-2"><span className="text-cyan-300">•</span><span>Canonical Arc Uniswap v3 token / USDC pools only.</span></li>
            <li className="flex gap-2"><span className="text-cyan-300">•</span><span>Initialized price, fee tier, tick spacing, and exact simulation.</span></li>
          </ul>
          <div className="mt-5 border-t border-white/10 pt-4 text-xs leading-5 text-amber-200/80">Actora does not detect honeypots, audit contracts, or endorse a token. You are responsible for the CA and the liquidity decision.</div>
        </aside>
      </div>
    </section>
  );
};
