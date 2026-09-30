import React, { useState } from "react";
import { parseUnits, formatUnits } from "viem";
import { api } from "../lib/api-client";
import type { AlphaPosition, AlphaWalletSummary } from "@stillwater/chain";
import { IconClose, IconArrowLeftRight, IconCheck, IconAlert } from "./Icons";

export type ModalType =
  | { type: "approve"; token: "USDC" | "cirBTC" }
  | { type: "mint" }
  | { type: "import" }
  | { type: "action"; kind: "increase" | "decrease" | "collect" | "withdraw"; position: AlphaPosition }
  | null;

type Props = {
  modal: ModalType;
  summary?: AlphaWalletSummary | null;
  currentTick?: number;
  onClose: () => void;
  onSuccess: () => Promise<void>;
  onNotify: (type: "success" | "error" | "info", title: string, message?: string) => void;
};

function parseHumanUnits(value: string, decimals: number, label: string, allowZero = false): string {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) {
    if (allowZero) return "0";
    throw new Error(`Please enter an amount for ${label}.`);
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid number format for ${label}: "${value}". Expected a decimal number.`);
  }
  try {
    const parsed = parseUnits(trimmed, decimals);
    if (!allowZero && parsed <= 0n) {
      throw new Error(`${label} amount must be greater than 0.`);
    }
    return parsed.toString();
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes(label)) {
      throw err;
    }
    throw new Error(`${label} exceeds maximum supported precision (${decimals} decimal places).`);
  }
}

const MODAL_TITLES = {
  approve: "Allow spending",
  mint: "Open a position",
  import: "Add a position you already own",
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

function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick) * 100;
}

function priceToTick(price: number): number {
  if (price <= 0) return 0;
  return Math.round(Math.log(price / 100) / Math.log(1.0001));
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

export const IntentActionModal: React.FC<Props> = ({
  modal,
  summary,
  currentTick,
  onClose,
  onSuccess,
  onNotify,
}) => {
  const [loading, setLoading] = useState(false);
  const [preparedIntent, setPreparedIntent] = useState<{
    intentId: string;
    gasEstimate?: string;
    simulationData?: any;
  } | null>(null);

  // Balances and spot price from summary
  const cirBtcBalFormatted = summary?.balances?.cirBtc?.formatted ?? "0";
  const cirBtcBalRaw = summary?.balances?.cirBtc?.raw ? BigInt(summary.balances.cirBtc.raw) : 0n;
  const usdcBalFormatted = summary?.balances?.usdc?.formatted ?? "0";
  const usdcBalRaw = summary?.balances?.usdc?.raw ? BigInt(summary.balances.usdc.raw) : 0n;
  const spotPrice = summary?.pool?.token1PerToken0 ? Number(summary.pool.token1PerToken0) : 0;

  // Primary input token toggle: cirBTC or USDC
  const [primaryToken, setPrimaryToken] = useState<"cirBTC" | "USDC">("cirBTC");
  const [approveToken, setApproveToken] = useState<"USDC" | "cirBTC">(
    modal?.type === "approve" ? modal.token : "USDC",
  );

  // Form states - Human-readable values
  const [approveAmount, setApproveAmount] = useState("2");
  const [mintTickLower, setMintTickLower] = useState(
    currentTick !== undefined ? String(currentTick - 100) : "66860",
  );
  const [mintTickUpper, setMintTickUpper] = useState(
    currentTick !== undefined ? String(currentTick + 100) : "67060",
  );
  const [minPrice, setMinPrice] = useState(
    currentTick !== undefined ? tickToPrice(currentTick - 100).toFixed(2) : "80084.36",
  );
  const [maxPrice, setMaxPrice] = useState(
    currentTick !== undefined ? tickToPrice(currentTick + 100).toFixed(2) : "81702.09",
  );
  const [showTechnical, setShowTechnical] = useState(false);

  const [mintCirBtc, setMintCirBtc] = useState("0.00002465");
  const [mintUsdc, setMintUsdc] = useState("2");
  const [importTokenId, setImportTokenId] = useState("");
  const [actionAmountCirBtc, setActionAmountCirBtc] = useState("0.00002465");
  const [actionAmountUsdc, setActionAmountUsdc] = useState("2");
  const [actionLiquidity, setActionLiquidity] = useState("");

  React.useEffect(() => {
    if (modal?.type === "mint" && currentTick !== undefined) {
      const lower = currentTick - 100;
      const upper = currentTick + 100;
      setMintTickLower(String(lower));
      setMintTickUpper(String(upper));
      setMinPrice(tickToPrice(lower).toFixed(2));
      setMaxPrice(tickToPrice(upper).toFixed(2));
    }
    if (modal?.type === "approve") {
      setApproveToken(modal.token);
      setApproveAmount(
        modal.token === "cirBTC"
          ? (cirBtcBalFormatted !== "0" ? cirBtcBalFormatted : "0.00002465")
          : "2",
      );
    }
  }, [modal, currentTick, cirBtcBalFormatted]);

  if (!modal) return null;

  // Calculates required paired token amount given the concentrated range and pool tick
  const getPairedAmount = (
    fromToken: "cirBTC" | "USDC",
    amountNum: number,
    tickLowerStr: string,
    tickUpperStr: string,
  ): number => {
    if (amountNum <= 0 || currentTick === undefined) return 0;
    const tLower = parseInt(tickLowerStr, 10);
    const tUpper = parseInt(tickUpperStr, 10);
    if (isNaN(tLower) || isNaN(tUpper) || tLower >= tUpper) {
      return fromToken === "cirBTC" ? amountNum * spotPrice : (spotPrice > 0 ? amountNum / spotPrice : 0);
    }

    if (currentTick <= tLower || currentTick >= tUpper) {
      return 0;
    }

    const sqrtP = Math.pow(1.0001, currentTick / 2);
    const sqrtPl = Math.pow(1.0001, tLower / 2);
    const sqrtPu = Math.pow(1.0001, tUpper / 2);

    const deltaLower = sqrtP - sqrtPl;
    const deltaUpper = sqrtPu - sqrtP;
    if (deltaUpper <= 0 || deltaLower <= 0) {
      return fromToken === "cirBTC" ? amountNum * spotPrice : (spotPrice > 0 ? amountNum / spotPrice : 0);
    }

    const rawRatio = (sqrtP * sqrtPu * deltaLower) / deltaUpper;
    const humanRatio = rawRatio * 100;

    if (fromToken === "cirBTC") {
      return amountNum * humanRatio;
    } else {
      return humanRatio > 0 ? amountNum / humanRatio : 0;
    }
  };

  const handleSelectRangePreset = (pct: number) => {
    if (currentTick === undefined) return;
    const currentP = tickToPrice(currentTick);
    const minP = currentP * (1 - pct / 100);
    const maxP = currentP * (1 + pct / 100);
    const lower = priceToTick(minP);
    const upper = priceToTick(maxP);
    setMintTickLower(String(lower));
    setMintTickUpper(String(upper));
    setMinPrice(minP.toFixed(2));
    setMaxPrice(maxP.toFixed(2));

    const cirBtcNum = Number(mintCirBtc.trim().replace(",", "."));
    if (!isNaN(cirBtcNum) && cirBtcNum > 0) {
      setMintUsdc(getPairedAmount("cirBTC", cirBtcNum, String(lower), String(upper)).toFixed(4));
    }
  };

  const handleMinPriceChange = (val: string) => {
    setMinPrice(val);
    const num = parseFloat(val.trim().replace(",", "."));
    if (!isNaN(num) && num > 0) {
      const lower = priceToTick(num);
      setMintTickLower(String(lower));
      const cirBtcNum = Number(mintCirBtc.trim().replace(",", "."));
      if (!isNaN(cirBtcNum) && cirBtcNum > 0) {
        setMintUsdc(getPairedAmount("cirBTC", cirBtcNum, String(lower), mintTickUpper).toFixed(4));
      }
    }
  };

  const handleMaxPriceChange = (val: string) => {
    setMaxPrice(val);
    const num = parseFloat(val.trim().replace(",", "."));
    if (!isNaN(num) && num > 0) {
      const upper = priceToTick(num);
      setMintTickUpper(String(upper));
      const cirBtcNum = Number(mintCirBtc.trim().replace(",", "."));
      if (!isNaN(cirBtcNum) && cirBtcNum > 0) {
        setMintUsdc(getPairedAmount("cirBTC", cirBtcNum, mintTickLower, String(upper)).toFixed(4));
      }
    }
  };

  const handleLowerTickChange = (val: string) => {
    setMintTickLower(val);
    const num = parseInt(val, 10);
    if (!isNaN(num)) {
      setMinPrice(tickToPrice(num).toFixed(2));
      const cirBtcNum = Number(mintCirBtc.trim().replace(",", "."));
      if (!isNaN(cirBtcNum) && cirBtcNum > 0) {
        setMintUsdc(getPairedAmount("cirBTC", cirBtcNum, val, mintTickUpper).toFixed(4));
      }
    }
  };

  const handleUpperTickChange = (val: string) => {
    setMintTickUpper(val);
    const num = parseInt(val, 10);
    if (!isNaN(num)) {
      setMaxPrice(tickToPrice(num).toFixed(2));
      const cirBtcNum = Number(mintCirBtc.trim().replace(",", "."));
      if (!isNaN(cirBtcNum) && cirBtcNum > 0) {
        setMintUsdc(getPairedAmount("cirBTC", cirBtcNum, mintTickLower, val).toFixed(4));
      }
    }
  };

  const handleCirBtcPercent = (pct: number, target: "mint" | "increase" | "approve") => {
    if (cirBtcBalRaw <= 0n) {
      onNotify("info", "No cirBTC Available", "Managed wallet currently has 0 cirBTC.");
      return;
    }
    const raw = pct === 100 ? cirBtcBalRaw : (cirBtcBalRaw * BigInt(pct)) / 100n;
    if (raw <= 0n) return;
    const val = formatUnits(raw, 8);
    if (target === "mint") {
      setMintCirBtc(val);
      setMintUsdc(getPairedAmount("cirBTC", Number(val), mintTickLower, mintTickUpper).toFixed(4));
    } else if (target === "increase") {
      setActionAmountCirBtc(val);
      if (modal?.type === "action") {
        setActionAmountUsdc(
          getPairedAmount("cirBTC", Number(val), String(modal.position.tickLower), String(modal.position.tickUpper)).toFixed(4)
        );
      } else if (spotPrice > 0) {
        setActionAmountUsdc((Number(val) * spotPrice).toFixed(4));
      }
    } else if (target === "approve") {
      setApproveAmount(val);
    }
  };

  const handleUsdcPercent = (pct: number, target: "mint" | "increase" | "approve") => {
    if (usdcBalRaw <= 0n) {
      onNotify("info", "No USDC Available", "Managed wallet currently has 0 USDC.");
      return;
    }
    const raw = pct === 100 ? usdcBalRaw : (usdcBalRaw * BigInt(pct)) / 100n;
    if (raw <= 0n) return;
    const val = formatUnits(raw, 6);
    if (target === "mint") {
      setMintUsdc(val);
      setMintCirBtc(getPairedAmount("USDC", Number(val), mintTickLower, mintTickUpper).toFixed(8));
    } else if (target === "increase") {
      setActionAmountUsdc(val);
      if (modal?.type === "action") {
        setActionAmountCirBtc(
          getPairedAmount("USDC", Number(val), String(modal.position.tickLower), String(modal.position.tickUpper)).toFixed(8)
        );
      } else if (spotPrice > 0) {
        setActionAmountCirBtc((Number(val) / spotPrice).toFixed(8));
      }
    } else if (target === "approve") {
      setApproveAmount(val);
    }
  };

  const handleMintCirBtcChange = (val: string) => {
    setMintCirBtc(val);
    const num = Number(val.trim().replace(",", "."));
    if (!isNaN(num) && num > 0) {
      setMintUsdc(getPairedAmount("cirBTC", num, mintTickLower, mintTickUpper).toFixed(4));
    }
  };

  const handleMintUsdcChange = (val: string) => {
    setMintUsdc(val);
    const num = Number(val.trim().replace(",", "."));
    if (!isNaN(num) && num > 0) {
      setMintCirBtc(getPairedAmount("USDC", num, mintTickLower, mintTickUpper).toFixed(8));
    }
  };

  const handleIncreaseCirBtcChange = (val: string) => {
    setActionAmountCirBtc(val);
    const num = Number(val.trim().replace(",", "."));
    if (!isNaN(num) && num > 0) {
      if (modal?.type === "action") {
        setActionAmountUsdc(
          getPairedAmount("cirBTC", num, String(modal.position.tickLower), String(modal.position.tickUpper)).toFixed(4)
        );
      } else if (spotPrice > 0) {
        setActionAmountUsdc((num * spotPrice).toFixed(4));
      }
    }
  };

  const handleIncreaseUsdcChange = (val: string) => {
    setActionAmountUsdc(val);
    const num = Number(val.trim().replace(",", "."));
    if (!isNaN(num) && num > 0) {
      if (modal?.type === "action") {
        setActionAmountCirBtc(
          getPairedAmount("USDC", num, String(modal.position.tickLower), String(modal.position.tickUpper)).toFixed(8)
        );
      } else if (spotPrice > 0) {
        setActionAmountCirBtc((num / spotPrice).toFixed(8));
      }
    }
  };

  const handlePrepare = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const idempotencyKey = `intent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    try {
      if (modal.type === "approve") {
        const decimals = approveToken === "USDC" ? 6 : 8;
        const rawAmount = parseHumanUnits(approveAmount, decimals, approveToken);
        const res = await api.prepareApproval(approveToken, rawAmount, idempotencyKey);
        setPreparedIntent({
          intentId: res.intentId,
          gasEstimate: res.simulation.gasEstimate,
          simulationData: res.approval,
        });
        onNotify("info", "Ready to confirm", "Check the details, then confirm to send.");
      } else if (modal.type === "mint") {
        const rawCirBtc = parseHumanUnits(mintCirBtc, 8, "cirBTC");
        const rawUsdc = parseHumanUnits(mintUsdc, 6, "USDC");
        const deadline = String(Math.floor(Date.now() / 1000) + 1800); // 30m
        const res = await api.prepareMint({
          tickLower: parseInt(mintTickLower, 10),
          tickUpper: parseInt(mintTickUpper, 10),
          amountCirBtc: rawCirBtc,
          amountUsdc: rawUsdc,
          slippageBps: 100, // 1%
          deadline,
          idempotencyKey,
        });
        setPreparedIntent({
          intentId: res.intentId,
          gasEstimate: res.simulation.gasEstimate,
          simulationData: res.simulation,
        });
        onNotify("info", "Ready to confirm", "Check the details, then confirm to send.");
      } else if (modal.type === "import") {
        const res = await api.importPosition(importTokenId.trim(), idempotencyKey);
        setPreparedIntent({
          intentId: res.intentId,
          simulationData: res.position,
        });
        onNotify("success", "Position found", `Position #${res.position.tokenId} belongs to your Stillwater wallet.`);
      } else if (modal.type === "action") {
        const deadline = String(Math.floor(Date.now() / 1000) + 1800);
        const rawCirBtc = modal.kind === "increase" ? parseHumanUnits(actionAmountCirBtc, 8, "cirBTC", true) : undefined;
        const rawUsdc = modal.kind === "increase" ? parseHumanUnits(actionAmountUsdc, 6, "USDC", true) : undefined;
        const res = await api.preparePositionAction({
          action: modal.kind,
          kind: modal.kind,
          tokenId: modal.position.tokenId,
          amountCirBtc: rawCirBtc,
          amountUsdc: rawUsdc,
          liquidity:
            modal.kind === "decrease"
              ? actionLiquidity.trim() || modal.position.liquidity
              : modal.kind === "withdraw"
                ? modal.position.liquidity
                : undefined,
          slippageBps: 100,
          deadline,
          idempotencyKey,
        });
        setPreparedIntent({
          intentId: res.intentId,
          gasEstimate: res.simulation.gasEstimate,
          simulationData: res.simulation.output,
        });
        onNotify("info", "Ready to confirm", "Check the details, then confirm to send.");
      }
    } catch (err: unknown) {
      console.error("Preparation failed", err);
      const msg = err instanceof Error ? err.message : "Preparation failed";
      onNotify("error", "Couldn't prepare this action", msg);
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!preparedIntent) return;
    setLoading(true);
    try {
      // Importing only verifies ownership; there is no transaction to send.
      if (modal.type === "import") {
        await onSuccess();
        onClose();
        return;
      }
      const res = await api.executeIntent(preparedIntent.intentId);
      onNotify(
        "info",
        "Transaction sent",
        `Waiting for Arc to confirm ${res.transactionHash.slice(0, 10)}…`,
      );

      let confirmed = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          const rec = await api.reconcileAttempt(res.attemptId);
          if (rec.status === "confirmed") {
            onNotify(
              "success",
              "Done",
              "Arc confirmed the transaction.",
            );
            confirmed = true;
            break;
          }
        } catch {
          // Retry
        }
      }

      if (!confirmed) {
        onNotify(
          "info",
          "Transaction sent",
          "Still waiting for Arc to confirm. Your positions will update when it does.",
        );
      }

      await onSuccess();
      onClose();
    } catch (err: unknown) {
      console.error("Execution error", err);
      const msg = err instanceof Error ? err.message : "Execution failed";
      onNotify("error", "Couldn't send the transaction", msg);
    } finally {
      setLoading(false);
    }
  };

  const renderToggleBar = (current: "cirBTC" | "USDC", onToggle: () => void) => (
    <div className="flex items-center justify-center my-1">
      <button
        type="button"
        onClick={onToggle}
        className="group inline-flex items-center gap-2 rounded-full border border-line bg-field px-3 py-1 text-[.95rem] font-semibold text-ink hover:border-feed-line hover:bg-feed-soft hover:text-link transition-all active:scale-95 shadow-sm"
        title="Switch which amount you type in"
      >
        <span className={current === "cirBTC" ? "font-bold text-link" : "text-ink-muted"}>
          cirBTC
        </span>
        <span className="text-link group-hover:scale-125 transition-transform duration-150">
          <IconArrowLeftRight size={13} />
        </span>
        <span className={current === "USDC" ? "font-bold text-link" : "text-ink-muted"}>
          USDC
        </span>
        {spotPrice > 0 ? (
          <span className="border-l border-line pl-2 text-[.85rem] text-ink-muted">
            1 cirBTC ≈ ${spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        ) : null}
      </button>
    </div>
  );

  const mintCirBtcField = (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <label className="block text-[.95rem] font-semibold text-ink">
            cirBTC to deposit
          </label>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.2 text-[.8rem] font-semibold tracking-wide ${
              primaryToken === "cirBTC"
                ? "border border-feed-line bg-feed-soft text-link"
                : "border border-line bg-field text-ink-muted"
            }`}
          >
            {primaryToken === "cirBTC" ? "You enter" : "Auto-matched"}
          </span>
        </div>
        <span className="text-[.85rem] font-mono text-ink-muted">
          Available: {cirBtcBalFormatted} cirBTC
        </span>
      </div>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={mintCirBtc}
          onChange={(e) => handleMintCirBtcChange(e.target.value)}
          className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2.5 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all pr-20"
          placeholder="e.g. 0.00002465"
          required
        />
        <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-muted pointer-events-none">
          cirBTC
        </span>
      </div>
      <PercentageButtons onSelect={(pct) => handleCirBtcPercent(pct, "mint")} />
    </div>
  );

  const mintUsdcField = (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <label className="block text-[.95rem] font-semibold text-ink">
            USDC to deposit
          </label>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.2 text-[.8rem] font-semibold tracking-wide ${
              primaryToken === "USDC"
                ? "border border-feed-line bg-feed-soft text-link"
                : "border border-line bg-field text-ink-muted"
            }`}
          >
            {primaryToken === "USDC" ? "You enter" : "Auto-matched"}
          </span>
        </div>
        <span className="text-[.85rem] font-mono text-ink-muted">
          Available: {usdcBalFormatted} USDC
        </span>
      </div>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={mintUsdc}
          onChange={(e) => handleMintUsdcChange(e.target.value)}
          className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2.5 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all pr-16"
          placeholder="e.g. 2.0"
          required
        />
        <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-muted pointer-events-none">
          USDC
        </span>
      </div>
      <PercentageButtons onSelect={(pct) => handleUsdcPercent(pct, "mint")} />
    </div>
  );

  const increaseCirBtcField = (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <label className="block text-[.95rem] font-semibold text-ink">
            cirBTC to add
          </label>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.2 text-[.8rem] font-semibold tracking-wide ${
              primaryToken === "cirBTC"
                ? "border border-feed-line bg-feed-soft text-link"
                : "border border-line bg-field text-ink-muted"
            }`}
          >
            {primaryToken === "cirBTC" ? "You enter" : "Auto-matched"}
          </span>
        </div>
        <span className="text-[.85rem] font-mono text-ink-muted">
          Available: {cirBtcBalFormatted} cirBTC
        </span>
      </div>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={actionAmountCirBtc}
          onChange={(e) => handleIncreaseCirBtcChange(e.target.value)}
          className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2.5 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all pr-20"
          placeholder="e.g. 0.00002465"
          required
        />
        <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-muted pointer-events-none">
          cirBTC
        </span>
      </div>
      <PercentageButtons onSelect={(pct) => handleCirBtcPercent(pct, "increase")} />
    </div>
  );

  const increaseUsdcField = (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <label className="block text-[.95rem] font-semibold text-ink">
            USDC to add
          </label>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.2 text-[.8rem] font-semibold tracking-wide ${
              primaryToken === "USDC"
                ? "border border-feed-line bg-feed-soft text-link"
                : "border border-line bg-field text-ink-muted"
            }`}
          >
            {primaryToken === "USDC" ? "You enter" : "Auto-matched"}
          </span>
        </div>
        <span className="text-[.85rem] font-mono text-ink-muted">
          Available: {usdcBalFormatted} USDC
        </span>
      </div>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={actionAmountUsdc}
          onChange={(e) => handleIncreaseUsdcChange(e.target.value)}
          className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2.5 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all pr-16"
          placeholder="e.g. 2.0"
          required
        />
        <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-muted pointer-events-none">
          USDC
        </span>
      </div>
      <PercentageButtons onSelect={(pct) => handleUsdcPercent(pct, "increase")} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 text-ink backdrop-blur-sm [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-3 [&_button:focus-visible]:outline-link">
      <div className="w-full max-w-[600px] rounded-[28px] border border-line bg-card p-8 shadow-2xl max-h-[90vh] overflow-y-auto overscroll-contain">
        <div className="flex items-center justify-between pb-4 border-b border-line mb-4">
          <h3 className="text-[1.6rem] font-semibold text-ink">
            {modal.type === "action" ? MODAL_TITLES[modal.kind] : MODAL_TITLES[modal.type]}
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
            {modal.type === "approve" ? (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[.95rem] font-semibold text-ink">
                    Amount ({approveToken})
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const next = approveToken === "USDC" ? "cirBTC" : "USDC";
                      setApproveToken(next);
                      setApproveAmount(
                        next === "cirBTC"
                          ? (cirBtcBalFormatted !== "0" ? cirBtcBalFormatted : "0.00002465")
                          : "2",
                      );
                    }}
                    className="inline-flex items-center gap-1.5 rounded-[14px] border border-line bg-field px-2.5 py-1 text-[.95rem] font-semibold text-link hover:bg-feed-soft hover:border-feed-line transition-all active:scale-95"
                    title="Switch token to approve"
                  >
                    <IconArrowLeftRight size={13} />
                    <span>Switch to {approveToken === "USDC" ? "cirBTC" : "USDC"}</span>
                  </button>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={approveAmount}
                    onChange={(e) => setApproveAmount(e.target.value)}
                    className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2.5 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all pr-16"
                    placeholder={approveToken === "USDC" ? "e.g. 2.0" : "e.g. 0.00002465"}
                    required
                  />
                  <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-muted pointer-events-none">
                    {approveToken}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[.85rem] text-ink-muted">
                  <span>
                    Available: {approveToken === "cirBTC" ? `${cirBtcBalFormatted} cirBTC` : `${usdcBalFormatted} USDC`}
                  </span>
                </div>
                <PercentageButtons onSelect={(pct) => {
                  if (approveToken === "cirBTC") {
                    handleCirBtcPercent(pct, "approve");
                  } else {
                    handleUsdcPercent(pct, "approve");
                  }
                }} />
              </div>
            ) : null}

            {modal.type === "mint" ? (
              <>
                {/* Price Range Section */}
                <div className="rounded-[18px] border border-line bg-field p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[.95rem] font-semibold text-ink">
                        Price Range (Min & Max Price)
                      </div>
                      <div className="text-[.85rem] text-ink-muted mt-0.5">
                        Your position earns fees while Bitcoin price is inside this range.
                      </div>
                    </div>
                    {currentTick !== undefined ? (
                      <div className="text-right">
                        <div className="text-[.8rem] uppercase font-semibold text-ink-muted tracking-wide">
                          Current Price
                        </div>
                        <div className="font-mono text-[1rem] font-semibold text-ink">
                          ${tickToPrice(currentTick).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* Preset Buttons */}
                  {currentTick !== undefined ? (
                    <div>
                      <div className="text-[.85rem] text-ink-muted mb-1.5 font-medium">Quick Range Presets:</div>
                      <div className="flex gap-1.5">
                        {[
                          { label: "±1% (Narrow)", pct: 1 },
                          { label: "±5% (Normal)", pct: 5 },
                          { label: "±10% (Wide)", pct: 10 },
                          { label: "±20% (Safe)", pct: 20 },
                        ].map((preset) => {
                          const currentP = tickToPrice(currentTick);
                          const lower = priceToTick(currentP * (1 - preset.pct / 100));
                          const upper = priceToTick(currentP * (1 + preset.pct / 100));
                          const isActive =
                            mintTickLower === String(lower) && mintTickUpper === String(upper);
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => handleSelectRangePreset(preset.pct)}
                              className={`flex-1 rounded-[14px] border py-1.5 text-[.95rem] font-semibold transition-all active:scale-95 ${
                                isActive
                                  ? "border-accent bg-feed-soft text-link shadow-sm"
                                  : "border-line bg-card text-ink hover:bg-tint"
                              }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Min Price & Max Price Inputs */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[.95rem] font-semibold text-ink">
                          Min Price (USD)
                        </label>
                        <span className="text-[.8rem] font-mono text-ink-faint">
                          Tick: {mintTickLower}
                        </span>
                      </div>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-faint pointer-events-none">
                          $
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={minPrice}
                          onChange={(e) => handleMinPriceChange(e.target.value)}
                          className="w-full rounded-[18px] border border-line bg-card pl-6 pr-3 py-2 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all"
                          placeholder="e.g. 80000"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[.95rem] font-semibold text-ink">
                          Max Price (USD)
                        </label>
                        <span className="text-[.8rem] font-mono text-ink-faint">
                          Tick: {mintTickUpper}
                        </span>
                      </div>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[.95rem] font-semibold text-ink-faint pointer-events-none">
                          $
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={maxPrice}
                          onChange={(e) => handleMaxPriceChange(e.target.value)}
                          className="w-full rounded-[18px] border border-line bg-card pl-6 pr-3 py-2 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all"
                          placeholder="e.g. 82000"
                          required
                        />
                      </div>
                    </div>
                  </div>

                  {/* Range Status & Advanced Toggle */}
                  <div className="flex items-center justify-between text-[.95rem] pt-1 border-t border-line">
                    {currentTick !== undefined &&
                    !isNaN(parseInt(mintTickLower, 10)) &&
                    !isNaN(parseInt(mintTickUpper, 10)) ? (
                      <span
                        className={`font-semibold ${
                          currentTick >= parseInt(mintTickLower, 10) &&
                          currentTick <= parseInt(mintTickUpper, 10)
                            ? "text-link"
                            : "text-rest"
                        }`}
                      >
                        {currentTick >= parseInt(mintTickLower, 10) &&
                        currentTick <= parseInt(mintTickUpper, 10) ? (
                          <span className="inline-flex items-center gap-1">
                            <IconCheck size={12} /> Price is In Range (Active)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <IconAlert size={12} /> Out of Range (Inactive)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span />
                    )}

                    <button
                      type="button"
                      onClick={() => setShowTechnical(!showTechnical)}
                      className="text-[.85rem] text-ink-muted hover:text-ink underline"
                    >
                      {showTechnical ? "Hide technical details" : "Technical details"}
                    </button>
                  </div>

                  {/* Optional Raw Tick inputs for power users */}
                  {showTechnical ? (
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-line">
                      <div>
                        <label className="block text-[.85rem] font-semibold text-ink-muted mb-1">
                          Lower Tick Index
                        </label>
                        <input
                          type="number"
                          value={mintTickLower}
                          onChange={(e) => handleLowerTickChange(e.target.value)}
                          className="w-full rounded-[18px] border border-line bg-card px-3 py-1.5 font-mono text-[.95rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[.85rem] font-semibold text-ink-muted mb-1">
                          Upper Tick Index
                        </label>
                        <input
                          type="number"
                          value={mintTickUpper}
                          onChange={(e) => handleUpperTickChange(e.target.value)}
                          className="w-full rounded-[18px] border border-line bg-card px-3 py-1.5 font-mono text-[.95rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all"
                          required
                        />
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Primary/Secondary inputs with toggle icon */}
                {primaryToken === "cirBTC" ? (
                  <>
                    {mintCirBtcField}
                    {renderToggleBar(primaryToken, () => setPrimaryToken("USDC"))}
                    {mintUsdcField}
                  </>
                ) : (
                  <>
                    {mintUsdcField}
                    {renderToggleBar(primaryToken, () => setPrimaryToken("cirBTC"))}
                    {mintCirBtcField}
                  </>
                )}
              </>
            ) : null}

            {modal.type === "import" ? (
              <div>
                <label className="block text-[.95rem] font-semibold text-ink mb-1.5">
                  Position number
                </label>
                <input
                  type="text"
                  value={importTokenId}
                  onChange={(e) => setImportTokenId(e.target.value)}
                  placeholder="e.g. 12345"
                  className="w-full rounded-[18px] border border-line bg-field px-3.5 py-2 font-mono text-[1rem] text-ink focus:border-accent focus:bg-field focus:ring-2 focus:ring-band/30 placeholder:text-ink-faint outline-none transition-all"
                  required
                />
                <span className="mt-1 block text-[.85rem] text-ink-muted">
                  The number Uniswap shows for the position. It must already belong to your Stillwater wallet and be in the cirBTC/USDC pool. Nothing is sent; we only check it.
                </span>
              </div>
            ) : null}

            {modal.type === "action" && modal.kind === "collect" ? (
              <div className="rounded-[18px] border border-line bg-field p-4 text-[.95rem] text-ink leading-relaxed">
                Moves the fees this position has earned, about{" "}
                <strong className="text-ink">
                  {modal.position.claimable0.formatted} cirBTC and {modal.position.claimable1.formatted} USDC
                </strong>
                , into your Stillwater wallet. Anything you took out with Remove some comes along too. Your position stays open and keeps earning.
              </div>
            ) : null}

            {modal.type === "action" && modal.kind === "increase" ? (
              <>
                <p className="text-[.95rem] text-ink-muted leading-relaxed">
                  Adds more money to this position, keeping its current price range. Enter one amount and we match the other so both go in at the right ratio.
                </p>
                {primaryToken === "cirBTC" ? (
                  <>
                    {increaseCirBtcField}
                    {renderToggleBar(primaryToken, () => setPrimaryToken("USDC"))}
                    {increaseUsdcField}
                  </>
                ) : (
                  <>
                    {increaseUsdcField}
                    {renderToggleBar(primaryToken, () => setPrimaryToken("cirBTC"))}
                    {increaseCirBtcField}
                  </>
                )}
              </>
            ) : null}

            {modal.type === "action" && modal.kind === "decrease" ? (
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
                    const val = ((BigInt(modal.position.liquidity) * btn.mul) / btn.factor).toString();
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
                  {removalPercent(actionLiquidity, modal.position.liquidity) !== null
                    ? `You'll take out about ${removalPercent(actionLiquidity, modal.position.liquidity)}% of this position. `
                    : "Pick how much to take out. "}
                  The cirBTC and USDC you take out are held in the position until you press Collect fees, which moves them to your Stillwater wallet. To empty and close the position in one step, use Close position instead.
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
                      Liquidity units to remove (of {BigInt(modal.position.liquidity).toLocaleString()})
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

            {modal.type === "action" && modal.kind === "withdraw" ? (
              <div className="rounded-[18px] border border-line bg-field p-4 text-[.95rem] text-ink leading-relaxed">
                Takes everything out of this position, including your cirBTC, your USDC and any fees not yet collected, and moves it all into your Stillwater wallet. The position is then closed for good and stops earning.
                <p className="mt-2 text-[.85rem] text-ink-muted">
                  Technical details: one transaction that removes all liquidity, collects everything, and burns position #{modal.position.tokenId}.
                </p>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={
                loading ||
                (modal.type === "action" && modal.kind === "decrease" && !actionLiquidity.trim())
              }
              className="mt-2 w-full rounded-full bg-accent min-h-14 px-6 text-[.95rem] font-semibold text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-50 transition-all"
            >
              {loading ? "Checking on Arc…" : modal.type === "import" ? "Check position" : "Review"}
            </button>
          </form>
        ) : (
          /* Simulated Result Review & Execution */
          <div className="flex flex-col gap-4">
            {modal.type === "import" ? (
              <div className="rounded-[18px] border border-line bg-field p-4 text-[.95rem] leading-relaxed text-ink">
                Position <strong className="text-ink">#{preparedIntent.simulationData?.tokenId}</strong> belongs to your Stillwater wallet. It will now show in your positions.
              </div>
            ) : (
              <>
                {(() => {
                  const data = preparedIntent.simulationData;
                  const cirBtc = data?.amountCirBtc ?? data?.collectedCirBtc;
                  const usdc = data?.amountUsdc ?? data?.collectedUsdc;
                  if (cirBtc === undefined || usdc === undefined) return null;
                  const kind = modal.type === "action" ? modal.kind : modal.type;
                  const heading =
                    kind === "mint" ? "You'll deposit about"
                      : kind === "increase" ? "You'll add about"
                        : kind === "decrease" ? "You'll take out about"
                          : "Your Stillwater wallet will receive about";
                  return (
                    <div className="rounded-[18px] border border-line bg-field p-4 flex flex-col gap-2">
                      <div className="text-[.95rem] font-semibold text-ink">{heading}</div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-[18px] border border-line bg-card p-2.5 font-mono text-[.95rem] font-semibold text-ink">
                          {formatUnits(BigInt(cirBtc), 8)} cirBTC
                        </div>
                        <div className="rounded-[18px] border border-line bg-card p-2.5 font-mono text-[.95rem] font-semibold text-ink">
                          {formatUnits(BigInt(usdc), 6)} USDC
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
              </>
            )}

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
                {modal.type === "import" ? "Done" : loading ? "Sending…" : "Confirm and send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
