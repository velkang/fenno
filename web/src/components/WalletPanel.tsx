import { useEffect, useRef, useState } from "react";
import { formatUnits, getAddress, isAddress, parseUnits, toHex } from "viem";
import { useAccount, useChainId, useSignTypedData } from "wagmi";
import { ARC_CHAIN_ID, withdrawalDomain, withdrawalTypes, type AlphaWalletSummary } from "@stillwater/chain";
import { api, type ManagedWalletRecord } from "../lib/api-client";

const MUTED_TEXT = "text-[.83rem] leading-[1.55] text-[#b6c1d1]";
const LABEL_TEXT = "text-[.77rem] text-[#a6b4c6]";
const WARNING_TEXT = "text-[.83rem] leading-[1.55] text-[#fbbf24]";
const OUTLINE_BUTTON = "rounded-lg border border-[#43536a] px-2.5 py-[7px] text-[.78rem] text-[#d7e5ef]";
const PRIMARY_BUTTON = "min-h-11 rounded-lg bg-[#059669] px-3.5 py-[9px] font-semibold text-white";
const TAB_BUTTON = "border-b-2 border-transparent px-0.5 py-[15px] text-[#a8b5c7] aria-selected:border-[#10b981] aria-selected:text-[#49dfaa]";
const FIELD_LABEL = "grid gap-2 text-[.83rem] text-[#d9e3ed]";
const FIELD_INPUT = "h-[45px] w-full rounded-lg border border-[#43536a] bg-[#151e2b] text-[#f3f4f6] focus:border-[#10b981] focus:shadow-[0_0_0_2px_#10b98140]";

type Props = {
  open: boolean;
  wallet: ManagedWalletRecord | null;
  canProvision: boolean;
  ownerAddress?: string;
  summary: AlphaWalletSummary | null;
  onClose: () => void;
  onProvision: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenAuth: () => void;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
};

export function WalletPanel({ open, wallet, canProvision, ownerAddress, summary, onClose, onProvision, onRefresh, onOpenAuth, onNotify }: Props) {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const [maximum, setMaximum] = useState<bigint | null>(null);
  const [feeReserve, setFeeReserve] = useState<bigint | null>(null);
  const [assets, setAssets] = useState<Array<{ address: string; symbol: string; decimals: number; raw: string }>>([]);
  const pendingKey = wallet ? `stillwater_withdrawal_attempt_${wallet.id}` : null;
  const [pendingAttempt, setPendingAttempt] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { address: connectedAddress } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const connectedOwner = !!connectedAddress && !!ownerAddress &&
    connectedAddress.toLowerCase() === ownerAddress.toLowerCase();
  const nativeRaw = BigInt(summary?.balances.nativeUsdc.raw ?? "0");
  const displayBalance = Number(formatUnits(nativeRaw, 18)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const validRecipient = isAddress(recipient) && recipient.toLowerCase() !== wallet?.address.toLowerCase() &&
    recipient.toLowerCase() !== "0x0000000000000000000000000000000000000000";
  let parsedAmount = 0n;
  try { parsedAmount = parseUnits(amount, 6); } catch { /* pending input */ }
  const validAmount = parsedAmount > 0n && maximum !== null && parsedAmount <= maximum;

  useEffect(() => {
    if (!open || !wallet || !isAddress(recipient)) { setMaximum(null); setFeeReserve(null); return; }
    let current = true;
    const timer = window.setTimeout(() => {
      api.getMaximumUsdcWithdrawal(recipient).then((result) => {
        if (current) { setMaximum(BigInt(result.maximum)); setFeeReserve(BigInt(result.feeReserve)); }
      }).catch(() => { if (current) { setMaximum(null); setFeeReserve(null); } });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [open, wallet, recipient]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !wallet) { setAssets([]); return; }
    let current = true;
    api.getWalletAssets().then((result) => { if (current) setAssets(result.assets); })
      .catch(() => { if (current) setAssets([]); });
    return () => { current = false; };
  }, [open, wallet, summary]);

  useEffect(() => {
    setPendingAttempt(pendingKey ? sessionStorage.getItem(pendingKey) : null);
  }, [pendingKey]);

  if (!open) return null;

  const withdraw = async () => {
    if (!wallet || !connectedOwner || !validRecipient || !validAmount || chainId !== ARC_CHAIN_ID) return;
    setBusy(true);
    try {
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const expiresAt = Math.floor(Date.now() / 1_000) + 5 * 60;
      const signature = await signTypedDataAsync({
        domain: withdrawalDomain,
        types: withdrawalTypes,
        primaryType: "UsdcWithdrawal",
        message: { wallet: getAddress(wallet.address), recipient: getAddress(recipient),
          amount: parsedAmount, nonce, expiresAt: BigInt(expiresAt) },
      });
      const prepared = await api.prepareUsdcWithdrawal({ recipient, amount: parsedAmount.toString(), nonce, expiresAt, signature });
      const executed = await api.executeIntent(prepared.intentId);
      if (pendingKey) sessionStorage.setItem(pendingKey, executed.attemptId);
      setPendingAttempt(executed.attemptId);
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const result = await api.reconcileAttempt(executed.attemptId);
        if (result.status === "confirmed") {
          if (pendingKey) sessionStorage.removeItem(pendingKey);
          setPendingAttempt(null);
          onNotify("success", "Withdrawal complete", `${amount} USDC sent to ${recipient.slice(0, 10)}…`);
          setAmount(""); setRecipient(""); setReview(false);
          await onRefresh();
          return;
        }
        if (result.status !== "pending" && result.status !== "submitted") {
          if (pendingKey) sessionStorage.removeItem(pendingKey);
          setPendingAttempt(null);
          throw new Error(result.reasonCode || "Withdrawal did not confirm");
        }
      }
      onNotify("info", "Withdrawal submitted", "Check the wallet balance for confirmation.");
    } catch (error) {
      onNotify("error", "Withdrawal not completed", error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };

  const checkPending = async () => {
    if (!pendingAttempt) return;
    try {
      const result = await api.reconcileAttempt(pendingAttempt);
      if (result.status === "confirmed" || result.status === "failed") {
        if (pendingKey) sessionStorage.removeItem(pendingKey);
        setPendingAttempt(null);
        await onRefresh();
        onNotify("info", "Previous withdrawal settled", "Review your balance before continuing.");
      } else onNotify("info", "Withdrawal pending", "Wait for confirmation before submitting another withdrawal.");
    } catch (error) {
      onNotify("error", "Could not check withdrawal", error instanceof Error ? error.message : "Try again.");
    }
  };

  return <div className="fixed inset-0 z-70 flex justify-end bg-[#05080ec7] text-[#f3f4f6]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="h-full w-[min(440px,100%)] overflow-auto border-l border-[#344256] bg-[#111827] p-7 shadow-[-20px_0_50px_#0006] max-[520px]:p-5" role="dialog" aria-modal="true" aria-labelledby="wallet-panel-title">
      <div className="flex items-start justify-between border-b border-[#29364a] pb-[22px]"><div><h2 id="wallet-panel-title" className="text-[1.35rem] font-bold">Wallet</h2><p className={MUTED_TEXT}>Your Stillwater wallet on Arc</p></div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close wallet" className={OUTLINE_BUTTON}>Close</button></div>
      {!wallet ? <div className="grid gap-4 py-[30px]"><p>{canProvision ? "Create your Stillwater wallet to receive Arc USDC." : "Sign in to create your Stillwater wallet."}</p>
        {!canProvision ? <button type="button" onClick={onOpenAuth} className={PRIMARY_BUTTON}>Sign in</button> : null}
        {canProvision ? <button type="button" onClick={onProvision} className={PRIMARY_BUTTON}>Create wallet</button> : null}</div>
        : <>
          <div className="grid gap-2 border-b border-[#29364a] py-[26px]"><span className={LABEL_TEXT}>USDC balance</span><strong className="text-[1.7rem] font-bold tabular-nums">{displayBalance} USDC</strong><small className={MUTED_TEXT}>One balance for transactions and Arc network fees</small></div>
          <div className="grid gap-2.5 border-b border-[#29364a] py-[23px]"><span className={LABEL_TEXT}>Stillwater address</span><code className="text-[.76rem] leading-normal wrap-anywhere text-[#e6edf5]">{wallet.address}</code>
            <button type="button" className={`${OUTLINE_BUTTON} justify-self-start`} onClick={async () => { await navigator.clipboard.writeText(wallet.address); onNotify("info", "Address copied"); }}>Copy address</button></div>
          <div className="mt-2 flex gap-5 border-b border-[#29364a]" role="tablist" aria-label="Wallet actions">
            <button role="tab" className={TAB_BUTTON} aria-selected={tab === "deposit"} onClick={() => { setTab("deposit"); setReview(false); }}>Deposit</button>
            <button role="tab" className={TAB_BUTTON} aria-selected={tab === "withdraw"} onClick={() => setTab("withdraw")}>Withdraw</button>
          </div>
          {tab === "deposit" ? <div className="grid gap-4 py-[22px]"><p className={MUTED_TEXT}>Send Arc USDC to the Stillwater address above from your wallet or exchange. This same USDC pays network fees and funds positions.</p>
            <a className="text-[.85rem] text-[#59dbad] underline underline-offset-3" href={`https://explorer.arc.io/address/${wallet.address}`} target="_blank" rel="noreferrer">View address on Arc Explorer</a></div>
            : <form className="grid gap-4 py-[22px]" onSubmit={(event) => { event.preventDefault(); if (review) void withdraw(); else setReview(true); }}>
              <label className={FIELD_LABEL}>Recipient address<input className={FIELD_INPUT} value={recipient} onChange={(event) => { setRecipient(event.target.value); setMaximum(null); setFeeReserve(null); setReview(false); }} placeholder="0x…" autoComplete="off" /></label>
              <label className={FIELD_LABEL}>Amount in USDC<input className={FIELD_INPUT} value={amount} onChange={(event) => { setAmount(event.target.value); setReview(false); }} inputMode="decimal" placeholder="0.00" /></label>
              <button type="button" className="justify-self-start text-[.77rem] text-[#65dfb4]" disabled={maximum === null}
                onClick={() => { setAmount(formatUnits(maximum ?? 0n, 6)); setReview(false); }}>Use available after fee reserve</button>
              {review && validRecipient && validAmount ? <p className={`${MUTED_TEXT} rounded-lg border border-[#43536a] p-3 wrap-anywhere`}>Send {amount} USDC to <code className="text-[#e5edf5]">{getAddress(recipient)}</code>. Your connected wallet will sign this exact withdrawal before Stillwater broadcasts it.</p> : null}
              {pendingAttempt ? <button type="button" onClick={() => void checkPending()}>Check pending withdrawal</button> : null}
              <button className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-45`} disabled={!validRecipient || !validAmount || busy || pendingAttempt !== null || !connectedOwner || chainId !== ARC_CHAIN_ID} type="submit">
                {busy ? "Processing withdrawal…" : review ? "Authorize withdrawal" : "Review withdrawal"}
              </button>
              {chainId !== ARC_CHAIN_ID ? <p className={WARNING_TEXT}>Switch the connected wallet to Arc Mainnet to withdraw.</p> : null}
              {!connectedOwner ? <p className={WARNING_TEXT}>Connect the wallet that signed in to authorize a withdrawal.</p> : null}
              <p className={MUTED_TEXT}>{feeReserve === null ? "Enter a recipient to estimate the network-fee reserve." :
                `Estimated fee reserve: ${formatUnits(feeReserve, 18)} USDC. The amount is checked again before signing.`}</p>
            </form>}
          {((summary && summary.balances.cirBtc.raw !== "0") || assets.length > 0) ? <div className="flex justify-between border-t border-[#29364a] pt-[18px] tabular-nums">
            <span className={LABEL_TEXT}>Other assets</span>
            {summary && summary.balances.cirBtc.raw !== "0" ? <strong>{summary.balances.cirBtc.formatted} cirBTC</strong> : null}
            {assets.map((asset) => <strong key={asset.address} title={asset.address}>
              {formatUnits(BigInt(asset.raw), asset.decimals)} {asset.symbol}</strong>)}
          </div> : null}
        </>}
    </section>
  </div>;
}
