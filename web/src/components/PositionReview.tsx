import { formatPoolPrice } from "../pages/ExplorePage";

type Props = {
  tokenSymbol: string;
  amountToken: string;
  amountUsdc: string;
  valueUsd: number;
  minPrice: number;
  maxPrice: number;
  feeLabel: string;
  steps: string[];
  maxTransactions: number;
  progress: string | null;
  busy: boolean;
  onConfirm: () => void;
  onEdit: () => void;
};

export const PRIMARY_ACTION = "flex min-h-[58px] w-full cursor-pointer items-center justify-center gap-2.5 rounded-[9px] border border-[#10b981] bg-[#059669] px-3.5 py-2.5 text-[.95rem] font-semibold text-white transition-[background-color,border-color] duration-140 ease-[ease] enabled:hover:border-[#34d399] enabled:hover:bg-[#047857] disabled:cursor-not-allowed disabled:border-[#33544c] disabled:bg-[#24463e] disabled:text-[#a3b8b2] max-[680px]:min-h-[54px]";
const FACT_TERM = "text-[.72rem] font-semibold tracking-[.04em] text-[#8190a5] uppercase";
const FACT_TEXT = "mt-0.5 mb-0 text-[.84rem] leading-normal text-[#b6c1d1]";

const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function PositionReview({ tokenSymbol, amountToken, amountUsdc, valueUsd, minPrice, maxPrice,
  feeLabel, steps, maxTransactions, progress, busy, onConfirm, onEdit }: Props) {
  return (
    <div className="mt-3.5 rounded-xl border border-[#29364a] bg-[#151e2b] p-4" role="region" aria-labelledby="deposit-review-title">
      <h3 id="deposit-review-title" className="mt-0 mb-3 text-base font-semibold text-[#f3f4f6]">Review your position</h3>
      <dl className="m-0 grid gap-2.5">
        <div><dt className={FACT_TERM}>You add</dt>
          <dd className={FACT_TEXT}>{amountToken || "0"} {tokenSymbol} + {amountUsdc || "0"} USDC <span className="text-[#8190a5]">≈ {usd(valueUsd)}</span></dd></div>
        <div><dt className={FACT_TERM}>You earn</dt>
          <dd className={FACT_TEXT}>{feeLabel} of each trade that uses your liquidity, while {tokenSymbol} trades between
            ${formatPoolPrice(minPrice)} and ${formatPoolPrice(maxPrice)}.</dd></div>
        <div><dt className={FACT_TERM}>If the price leaves your range</dt>
          <dd className={FACT_TEXT}>You stop earning until it comes back. Below ${formatPoolPrice(minPrice)} your position is
            all {tokenSymbol}; above ${formatPoolPrice(maxPrice)} it is all USDC.</dd></div>
        <div><dt className={FACT_TERM}>Withdraw</dt><dd className={FACT_TEXT}>Any time from My Positions. Both tokens return to your Stillwater wallet.</dd></div>
      </dl>
      <p className="mt-3.5 mb-1.5 text-[.8rem] text-[#b6c1d1]">Confirming sends {maxTransactions === 1 ? "1 transaction" : `up to ${maxTransactions} transactions`} from your Stillwater wallet:</p>
      <ol className="m-0 pl-5 text-[.8rem] leading-[1.6] text-[#b6c1d1]">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {progress ? <p className="mt-3 mb-0 text-[.8rem] text-[#f59e0b]" role="status">{progress}</p> : null}
      <div className="mt-3.5 grid grid-cols-[auto_1fr] gap-2">
        <button type="button" className="min-h-[58px] cursor-pointer rounded-[9px] border border-[#344256] bg-transparent px-[18px] text-[#dce5f2] disabled:cursor-not-allowed disabled:opacity-55" onClick={onEdit} disabled={busy}>Edit</button>
        <button type="button" className={PRIMARY_ACTION} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : "Confirm and open position"}
        </button>
      </div>
    </div>
  );
}
