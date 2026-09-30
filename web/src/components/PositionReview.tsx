type Props = {
  tokenSymbol: string;
  amountToken: string;
  amountUsdc: string;
  maxTransactions: number;
  progress: string | null;
  busy: boolean;
  onConfirm: () => void;
  onEdit: () => void;
};

export const PRIMARY_ACTION = "flex min-h-[60px] w-full items-center justify-center gap-2.5 rounded-full bg-accent px-6 text-[1.1rem] font-semibold text-on-accent transition-colors enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-tint disabled:text-ink-faint";

// Typed amounts can carry 18 decimals; six significant digits is plenty to check.
const amount = (value: string) => (Number.parseFloat(value) || 0).toLocaleString("en-US", { maximumSignificantDigits: 6 });

/** The last check before sending. The summary above it already shows the band, fee and value. */
export function PositionReview({ tokenSymbol, amountToken, amountUsdc, maxTransactions, progress, busy, onConfirm, onEdit }: Props) {
  return (
    <div className="flex flex-col gap-4 rounded-[22px] bg-sage p-5" role="region" aria-labelledby="deposit-review-title">
      <h3 id="deposit-review-title" className="text-[1.3rem] font-semibold text-ink">Check your pond</h3>
      <p className="text-[1.05rem] font-medium text-ink tabular-nums">
        {amount(amountToken)} {tokenSymbol} + {amount(amountUsdc)} USDC
      </p>
      <p className="text-[.95rem] leading-relaxed text-ink-muted">
        {maxTransactions === 1 ? "Sends 1 transaction." : `Sends up to ${maxTransactions} transactions, fewer if approvals are already in place.`}
      </p>
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
