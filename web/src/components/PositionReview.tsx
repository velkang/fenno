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

export const PRIMARY_ACTION = "flex min-h-[60px] w-full items-center justify-center gap-2.5 rounded-full bg-accent px-6 text-[1.1rem] font-semibold text-on-accent transition-colors enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-tint disabled:text-ink-faint";
const FACT_TERM = "text-[.85rem] font-semibold tracking-[.04em] text-ink-faint uppercase";
const FACT_TEXT = "mt-1 text-[1rem] leading-relaxed text-ink-muted";

const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function PositionReview({ tokenSymbol, amountToken, amountUsdc, valueUsd, minPrice, maxPrice,
  feeLabel, steps, maxTransactions, progress, busy, onConfirm, onEdit }: Props) {
  return (
    <div className="flex flex-col gap-4 rounded-[22px] bg-sage p-5" role="region" aria-labelledby="deposit-review-title">
      <h3 id="deposit-review-title" className="text-[1.3rem] font-semibold text-ink">Check your pond</h3>
      <dl className="grid gap-3">
        <div><dt className={FACT_TERM}>You add</dt>
          <dd className={FACT_TEXT}>{amountToken || "0"} {tokenSymbol} + {amountUsdc || "0"} USDC <span className="text-ink-faint">≈ {usd(valueUsd)}</span></dd></div>
        <div><dt className={FACT_TERM}>You earn</dt>
          <dd className={FACT_TEXT}>{feeLabel} of each trade that uses your liquidity, while {tokenSymbol} trades between
            ${formatPoolPrice(minPrice)} and ${formatPoolPrice(maxPrice)}.</dd></div>
        <div><dt className={FACT_TERM}>If the price leaves your band</dt>
          <dd className={FACT_TEXT}>The pond rests until the price comes back. Below ${formatPoolPrice(minPrice)} it holds only {tokenSymbol}; above ${formatPoolPrice(maxPrice)} it holds only USDC.</dd></div>
        <div><dt className={FACT_TERM}>Close it</dt><dd className={FACT_TEXT}>Any time from your Pond. Both tokens and any fees return to your Stillwater wallet.</dd></div>
      </dl>
      <p className="text-[.98rem] text-ink-muted">Confirming sends {maxTransactions === 1 ? "1 transaction" : `up to ${maxTransactions} transactions`} from your Stillwater wallet:</p>
      <ol className="list-decimal pl-6 text-[.98rem] leading-relaxed text-ink-muted">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {progress ? <p className="text-[.98rem] font-medium text-rest" role="status">{progress}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="min-h-[60px] rounded-full border border-line-strong px-6 text-[1.05rem] font-medium text-ink hover:bg-card disabled:cursor-not-allowed disabled:opacity-55" onClick={onEdit} disabled={busy}>Edit</button>
        <button type="button" className={`${PRIMARY_ACTION} w-auto flex-1`} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : "Confirm and open pond"}
        </button>
      </div>
    </div>
  );
}
