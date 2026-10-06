import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { fade, lift } from "../../lib/motion";

type Props = {
  pair: string;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Asks before a pond is closed. */
export function CloseDialog({ pair, onCancel, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Cancel is the safe default, so it takes focus first.
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <motion.div {...fade} className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <motion.div {...lift} role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-text"
        className="flex w-full max-w-[480px] flex-col gap-6 rounded-[28px] border border-line bg-card p-8 text-ink shadow-2xl">
        <div className="flex flex-col gap-2">
          <h2 id="close-title" className="text-[1.7rem] font-semibold">Close your {pair} pond?</h2>
          <p id="close-text" className="text-[1.05rem] leading-relaxed text-ink-muted">
            Both tokens and any fees it gathered go back to your Stillwater wallet. It stops earning once it&apos;s closed.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={onCancel}
            className="min-h-12 whitespace-nowrap rounded-full border border-line px-6 font-medium hover:bg-tint">
            Keep it
          </button>
          <button type="button" onClick={onConfirm}
            className="min-h-12 whitespace-nowrap rounded-full border border-danger-line bg-danger-soft px-7 font-semibold text-danger hover:brightness-95">
            Close pond
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
