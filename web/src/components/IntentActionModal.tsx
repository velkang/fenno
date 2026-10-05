import React, { useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { api } from "../lib/api-client";
import { waitForAttempt } from "../lib/attempts";
import { ARC_TOKENS, pairedAmount, type WalletSummary, type V3Position } from "@stillwater/chain";
import { formatPoolPrice, poolSpotPrice } from "../pages/ExplorePage";
import { IconClose, IconArrowLeftRight } from "./Icons";

export type ModalType =
  | { kind: "increase" | "decrease" | "collect" | "withdraw"; position: V3Position }
  | null;

type Props = {
  modal: ModalType;
  summary?: WalletSummary | null;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
};

type Side = "token" | "usdc";
// A simulated action reports token0 and token1 amounts under these names.
type SimulatedAmounts = {
  amount0?: string;
  amount1?: string;
  collected0?: string;
  collected1?: string;
};

function parseHumanUnits(value: string, decimals: number, label: string): string {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return "0";
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid number format for ${label}: "${value}". Expected a decimal number.`);
  }
  try {
    return parseUnits(trimmed, decimals).toString();
  } catch {
    throw new Error(`${label} exceeds maximum supported precision (${decimals} decimal places).`);
  }
}

const MODAL_TITLES = {
  collect: "Collect fees",
  increase: "Add more",
  decrease: "Remove some",
  withdraw: "Close position",
} as const;

function removalPercent(liquidity: string, total: string): number | null {
  try {
    const part = BigInt(liquidity.trim());
    const whole = BigInt(total);
    if (part <= 0n || whole <= 0n) return null;
    return Number((part * 1000n) / whole) / 10;
  } catch {
    return null;
  }
}

const PercentageButtons: React.FC<{
  onSelect: (pct: number) => void;
}> = ({ onSelect }) => (
  <div className="mt-1.5 flex gap-1.5">
    {[25, 50, 75, 100].map((pct) => (
      <button
        key={pct}
        type="button"
        onClick={() => onSelect(pct)}
        className="flex-1 rounded-[14px] border border-line bg-field py-1 text-[.95rem] font-semibold text-ink hover:bg-tint hover:border-line-strong transition-all active:scale-95"
      >
        {pct === 100 ? "100% (Max)" : `${pct}%`}
      </button>
    ))}
  </div>
);

/** Collect, add to, reduce or close a v3 position, whichever token it pairs with USDC. */
export const IntentActionModal: React.FC<Props> = ({
  modal,
  summary,
  onClose,
  onSuccess,
  onNotify,
}) => {
  const [loading, setLoading] = useState(false);
  const [preparedIntent, setPreparedIntent] = useState<{
    intentId: string;
    gasEstimate?: string;
    simulationData?: SimulatedAmounts;
  } | null>(null);
  // Which amount the user types; the other is matched to the position's band.
  const [primarySide, setPrimarySide] = useState<Side>("token");
  const [showTechnical, setShowTechnical] = useState(false);
  const [amounts, setAmounts] = useState<Record<Side, string>>({ token: "", usdc: "" });
  const [actionLiquidity, setActionLiquidity] = useState("");

  if (!modal) return null;

  const { kind, position } = modal;
  const { pool } = position;
  const tokenIsZero = pool.token0.toLowerCase() === pool.token.address.toLowerCase();
  const sides: Record<Side, { symbol: string; decimals: number; balance: bigint }> = {
    token: { symbol: pool.token.symbol, decimals: pool.token.decimals, balance: BigInt(pool.token.balance ?? "0") },
    usdc: { symbol: "USDC", decimals: ARC_TOKENS.USDC.decimals, balance: BigInt(summary?.balances.usdc.raw ?? "0") },
  };
  const spotPrice = poolSpotPrice(pool);
  // The pool lists its two tokens in a fixed order. This turns a (token, USDC) pair into
  // that order, and a pool-order pair back into (token, USDC): the same swap either way.
  const reorder = <T,>(first: T, second: T): [T, T] => (tokenIsZero ? [first, second] : [second, first]);

  const setAmount = (side: Side, value: string) => {
    const other: Side = side === "token" ? "usdc" : "token";
    const paired = pairedAmount({
      from: side,
      value,
      currentTick: pool.tick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      spotPrice,
      tokenDecimals: sides.token.decimals,
      usdcDecimals: sides.usdc.decimals,
      usdcIsPoolToken0: !tokenIsZero,
    });
    setAmounts({ [side]: value, [other]: paired } as Record<Side, string>);
  };

  const fillPercent = (side: Side, pct: number) => {
    const { balance, decimals, symbol } = sides[side];
    if (balance <= 0n) {
      onNotify("info", `No ${symbol} in your wallet`);
      return;
    }
    const raw = (balance * BigInt(pct)) / 100n;
    if (raw > 0n) setAmount(side, formatUnits(raw, decimals));
  };

  const handlePrepare = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const idempotencyKey = `intent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    try {
      const deadline = String(Math.floor(Date.now() / 1000) + 1800);
      const [amount0, amount1] = kind === "increase"
        ? reorder(
            parseHumanUnits(amounts.token, sides.token.decimals, sides.token.symbol),
            parseHumanUnits(amounts.usdc, sides.usdc.decimals, "USDC"),
          )
        : [undefined, undefined];
      const res = await api.preparePositionAction({
        action: kind,
        kind,
        tokenId: position.tokenId,
        amount0: amount0,
        amount1: amount1,
        liquidity:
          kind === "decrease"
            ? actionLiquidity.trim() || position.liquidity
            : kind === "withdraw"
              ? position.liquidity
              : undefined,
        slippageBps: 100,
        deadline,
        idempotencyKey,
      });
      setPreparedIntent({
        intentId: res.intentId,
        gasEstimate: res.simulation.gasEstimate,
        simulationData: res.simulation.output as SimulatedAmounts,
      });
      onNotify("info", "Ready to confirm");
    } catch (err: unknown) {
      console.error("Preparation failed", err);
      const msg = err instanceof Error ? err.message : "Preparation failed";
      onNotify("error", "Couldn't prepare this", msg);
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!preparedIntent) return;
    setLoading(true);
    try {
      const res = await api.executeIntent(preparedIntent.intentId);
      onNotify(
        "info",
        "Transaction sent",
        "Waiting for Arc to confirm.",
      );

      await waitForAttempt(res.attemptId);
      onNotify("success", "Done");

      await onSuccess();
      onClose();
    } catch (err: unknown) {
      console.error("Execution error", err);
      const msg = err instanceof Error ? err.message : "Execution failed";
      onNotify("error", "Transaction failed", msg);
      // A failed transaction can still have cost a network fee: show current balances now.
      void onSuccess();
    } finally {
      setLoading(false);
    }
  };

  const toggleBar = (
    <div className="flex items-center justify-center my-1">
      <button
        type="button"
        onClick={() => setPrimarySide(primarySide === "token" ? "usdc" : "token")}
        className="group inline-flex items-center gap-2 rounded-full border border-line bg-field px-3 py-1 text-[.95rem] font-semibold text-ink hover:border-feed-line hover:bg-feed-soft hover:text-link transition-all active:scale-95 shadow-sm"
        title="Switch which amount you type in"
      >
        <span className={primarySide === "token" ? "font-bold text-link" : "text-ink-muted"}>
          {sides.token.symbol}
        </span>
        <span className="text-link group-hover:scale-125 transition-transform duration-150">
          <IconArrowLeftRight size={13} />
        </span>
        <span className={primarySide === "usdc" ? "font-bold text-link" : "text-ink-muted"}>
          USDC
        </span>
        {spotPrice > 0 ? (
          <span className="border-l border-line pl-2 text-[.85rem] text-ink-muted">
            1 {sides.token.symbol} ≈ ${formatPoolPrice(spotPrice)}
          </span>
        ) : null}
      </button>
    </div>
  );

  const amountField = (side: Side) => {
    const { symbol, decimals, balance } = sides[side];
    const inputId = `increase-${side}`;
    return (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="block text-[.95rem] font-semibold text-ink">
              {symbol} to add
            </label>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.2 text-[.8rem] font-semibold tracking-wide ${
                primarySide === side
                  ? "border border-feed-line bg-feed-soft text-link"
                  : "border border-line bg-field text-ink-muted"
              }`}
            >
              {primarySide === side ? "You enter" : "Auto-matched"}
            </span>
          </div>
          <span className="text-[.85rem] font-mono text-ink-muted">
            Available: {formatUnits(balance, decimals)} {symbol}
          </span>
        </div>
        <div className="relative">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={amounts[side]}
            onChange={(e) => setAmount(side, e.target.value)}
            className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2.5 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all pr-20"
            placeholder="0.0"
            required
          />
          <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-muted pointer-events-none">
            {symbol}
          </span>
        </div>
        <PercentageButtons onSelect={(pct) => fillPercent(side, pct)} />
      </div>
    );
  };

  const [claimableToken, claimableUsdc] = reorder(position.claimable0, position.claimable1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 text-ink backdrop-blur-sm [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-3 [&_button:focus-visible]:outline-link">
      <div className="w-full max-w-[600px] rounded-[28px] border border-line bg-card p-8 shadow-2xl max-h-[90vh] overflow-y-auto overscroll-contain">
        <div className="flex items-center justify-between pb-4 border-b border-line mb-4">
          <h3 className="text-[1.6rem] font-semibold text-ink">
            {MODAL_TITLES[kind]}
          </h3>
          <button
            onClick={onClose}
            className="rounded-[14px] p-1 text-ink-faint hover:text-ink hover:bg-tint transition-colors"
            aria-label="Close dialog"
          >
            <IconClose size={16} />
          </button>
        </div>

        {/* Preparation Form */}
        {!preparedIntent ? (
          <form onSubmit={handlePrepare} className="flex flex-col gap-4">
            {kind === "collect" ? (
              <div className="rounded-[18px] border border-line bg-field p-4 text-[.95rem] text-ink leading-relaxed">
                Moves the fees this position has earned, about{" "}
                <strong className="text-ink">
                  {claimableToken.formatted} {sides.token.symbol} and {claimableUsdc.formatted} USDC
                </strong>
                , into your Stillwater wallet. Anything you took out with Remove some comes along too. Your position stays open and keeps earning.
              </div>
            ) : null}

            {kind === "increase" ? (
              <>
                <p className="text-[.95rem] text-ink-muted leading-relaxed">
                  Adds more money to this position, keeping its current price range. Enter one amount and we match the other so both go in at the right ratio.
                </p>
                {amountField(primarySide)}
                {toggleBar}
                {amountField(primarySide === "token" ? "usdc" : "token")}
              </>
            ) : null}

            {kind === "decrease" ? (
              <div>
                <label className="block text-[.95rem] font-semibold text-ink mb-1.5">
                  How much do you want to take out?
                </label>
                <div className="flex gap-1.5">
                  {[
                    { label: "25%", factor: 4n, mul: 1n },
                    { label: "50%", factor: 2n, mul: 1n },
                    { label: "75%", factor: 4n, mul: 3n },
                    { label: "All", factor: 1n, mul: 1n },
                  ].map((btn) => {
                    const val = ((BigInt(position.liquidity) * btn.mul) / btn.factor).toString();
                    const isActive = actionLiquidity.trim() === val;
                    return (
                      <button
                        key={btn.label}
                        type="button"
                        onClick={() => setActionLiquidity(val)}
                        className={`flex-1 rounded-[14px] border py-1.5 text-[.95rem] font-semibold transition-all active:scale-95 ${
                          isActive
                            ? "border-accent bg-feed-soft text-link"
                            : "border-line bg-field text-ink hover:bg-tint"
                        }`}
                      >
                        {btn.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[.85rem] text-ink-muted leading-relaxed">
                  {removalPercent(actionLiquidity, position.liquidity) !== null
                    ? `You'll take out about ${removalPercent(actionLiquidity, position.liquidity)}% of this position. `
                    : "Pick how much to take out. "}
                  The {sides.token.symbol} and USDC you take out are held in the position until you press Collect fees, which moves them to your Stillwater wallet. To empty and close the position in one step, use Close position instead.
                </p>
                <button
                  type="button"
                  onClick={() => setShowTechnical(!showTechnical)}
                  className="mt-2 text-[.85rem] text-ink-muted hover:text-ink underline"
                >
                  {showTechnical ? "Hide technical details" : "Technical details"}
                </button>
                {showTechnical ? (
                  <div className="mt-2">
                    <label className="block text-[.85rem] font-semibold text-ink-muted mb-1">
                      Liquidity units to remove (of {BigInt(position.liquidity).toLocaleString()})
                    </label>
                    <input
                      type="text"
                      value={actionLiquidity}
                      onChange={(e) => setActionLiquidity(e.target.value)}
                      className="w-full rounded-[18px] border border-line bg-card px-3 py-1.5 font-mono text-[.95rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {kind === "withdraw" ? (
              <div className="rounded-[18px] border border-line bg-field p-4 text-[.95rem] text-ink leading-relaxed">
                Takes everything out of this position, including your {sides.token.symbol}, your USDC and any fees not yet collected, and moves it all into your Stillwater wallet. The position is then closed for good and stops earning.
                <p className="mt-2 text-[.85rem] text-ink-muted">
                  Technical details: one transaction that removes all liquidity, collects everything, and burns position #{position.tokenId}.
                </p>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={loading || (kind === "decrease" && !actionLiquidity.trim())}
              className="mt-2 w-full rounded-full bg-accent min-h-14 px-6 text-[.95rem] font-semibold text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-50 transition-all"
            >
              {loading ? "Checking on Arc…" : "Review"}
            </button>
          </form>
        ) : (
          /* Simulated Result Review & Execution */
          <div className="flex flex-col gap-4">
            {(() => {
              const data = preparedIntent.simulationData;
              const amount0 = data?.amount0 ?? data?.collected0;
              const amount1 = data?.amount1 ?? data?.collected1;
              if (amount0 === undefined || amount1 === undefined) return null;
              const [tokenRaw, usdcRaw] = reorder(amount0, amount1);
              const heading =
                kind === "increase" ? "You'll add about"
                  : kind === "decrease" ? "You'll take out about"
                    : "Your Stillwater wallet will receive about";
              return (
                <div className="rounded-[18px] border border-line bg-field p-4 flex flex-col gap-2">
                  <div className="text-[.95rem] font-semibold text-ink">{heading}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-[18px] border border-line bg-card p-2.5 font-mono text-[.95rem] font-semibold text-ink">
                      {formatUnits(BigInt(tokenRaw), sides.token.decimals)} {sides.token.symbol}
                    </div>
                    <div className="rounded-[18px] border border-line bg-card p-2.5 font-mono text-[.95rem] font-semibold text-ink">
                      {formatUnits(BigInt(usdcRaw), sides.usdc.decimals)} USDC
                    </div>
                  </div>
                  {kind === "decrease" ? (
                    <div className="text-[.85rem] text-ink-muted">
                      Held in the position until you press Collect fees.
                    </div>
                  ) : null}
                </div>
              );
            })()}

            <div className="text-[.85rem] text-ink-muted break-all">
              Technical details: request {preparedIntent.intentId}
              {preparedIntent.gasEstimate ? `, estimated ${preparedIntent.gasEstimate} gas` : ""}
            </div>

            <div className="flex gap-3 mt-1">
              <button
                type="button"
                onClick={() => setPreparedIntent(null)}
                className="flex-1 rounded-[18px] border border-line bg-card py-2.5 text-[.95rem] font-semibold text-ink hover:bg-tint active:scale-95 shadow-sm"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleExecute}
                disabled={loading}
                className="flex-1 rounded-full bg-accent py-2.5 text-[.95rem] font-semibold text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-50"
              >
                {loading ? "Sending…" : "Confirm and send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
