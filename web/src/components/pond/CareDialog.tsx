import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { api, ApiError, type Mandate } from "../../lib/api-client";
import { runFailureMessage } from "../../lib/automation";
import { fade, lift } from "../../lib/motion";
import type { Pond } from "../../lib/ponds";

type Mode = "off" | "ask" | "autopilot";
type BandChoice = Mandate["band"];

type Props = {
  pond: Pond;
  mandate?: Mandate;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
};

const MODES: { id: Mode; name: string; line: string }[] = [
  { id: "off", name: "Off", line: "Tomo leaves this pond to you." },
  { id: "ask", name: "Ask me first", line: "Tomo suggests a change and waits for you to approve it." },
  { id: "autopilot", name: "Autopilot", line: "Tomo makes the change and tells you afterwards." },
];
const BANDS: { id: BandChoice; name: string }[] = [
  { id: "agent", name: "Tomo chooses" },
  { id: "wide", name: "Wide ±25%" },
  { id: "balanced", name: "Balanced ±10%" },
  { id: "narrow", name: "Narrow ±3%" },
];
const OPTION = "flex cursor-pointer flex-col gap-0.5 rounded-[18px] border px-4 py-3";
const chosen = (on: boolean) => (on ? "border-accent bg-feed-soft" : "border-line bg-field hover:bg-tint");

/** Whether Tomo may look after one pond, and within what limits. */
export function CareDialog({ pond, mandate, onClose, onSaved, onError }: Props) {
  const live = mandate && mandate.status === "active" ? mandate : undefined;
  const [mode, setMode] = useState<Mode>(live?.mode ?? "ask");
  const [band, setBand] = useState<BandChoice>(mandate?.band ?? "agent");
  const suggestedLimit = Math.max(5, Math.ceil((pond.valueUsd ?? 0) * 1.5));
  const [limit, setLimit] = useState(String(mandate?.maxPositionUsd ?? suggestedLimit));
  const [perDay, setPerDay] = useState(mandate?.maxRunsPerDay ?? 2);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const limitUsd = Number(limit);
  const limitValid = Number.isInteger(limitUsd) && limitUsd >= 1 && limitUsd <= 1_000_000;
  const tooLow = limitValid && pond.valueUsd !== null && limitUsd < pond.valueUsd * 1.1;

  const save = async () => {
    setSaving(true);
    try {
      if (mode === "off") {
        if (mandate) await api.revokeMandate(mandate.id);
        onSaved(`Tomo won't change your ${pond.symbol} pond.`);
        return;
      }
      await api.saveMandate({ poolId: pond.poolId, mode, band, maxPositionUsd: limitUsd, maxRunsPerDay: perDay });
      onSaved(mode === "ask"
        ? `Tomo will suggest changes to your ${pond.symbol} pond for you to approve.`
        : `Tomo will look after your ${pond.symbol} pond and tell you what it did.`);
    } catch (error) {
      onError(error instanceof ApiError ? runFailureMessage(error.code) : "Couldn't save. Try again.");
      setSaving(false);
    }
  };

  return (
    <motion.div {...fade} className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <motion.div {...lift} role="dialog" aria-modal="true" aria-labelledby="care-title"
        className="flex max-h-[90vh] w-full max-w-[580px] flex-col gap-6 overflow-y-auto overscroll-contain rounded-[28px] border border-line bg-card p-8 text-ink shadow-2xl">
        <div className="flex flex-col gap-2">
          <h2 id="care-title" className="text-[1.7rem] font-semibold">Let Tomo look after your {pond.symbol} pond</h2>
          <p className="text-[1.05rem] leading-relaxed text-ink-muted">
            Tomo checks this pond every few minutes. When the price leaves the band or the pool starts emptying, Tomo
            decides whether to re-centre it, close it, or wait.
          </p>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-[1rem] font-semibold">What Tomo may do</legend>
          {MODES.map((option) => (
            <label key={option.id} className={`${OPTION} ${chosen(mode === option.id)}`}>
              <input type="radio" name="care-mode" value={option.id} checked={mode === option.id}
                onChange={() => setMode(option.id)} className="sr-only" />
              <span className="font-semibold">{option.name}</span>
              <span className="text-[.9rem] text-ink-muted">{option.line}</span>
            </label>
          ))}
        </fieldset>

        {mode !== "off" ? (
          <>
            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2 text-[1rem] font-semibold">New band when re-centring</legend>
              <div className="grid grid-cols-2 gap-2.5 max-[480px]:grid-cols-1">
                {BANDS.map((option) => (
                  <label key={option.id} className={`${OPTION} ${chosen(band === option.id)}`}>
                    <input type="radio" name="care-band" value={option.id} checked={band === option.id}
                      onChange={() => setBand(option.id)} className="sr-only" />
                    <span className="font-semibold">{option.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid grid-cols-2 gap-4 max-[480px]:grid-cols-1">
              <label className="flex flex-col gap-1.5">
                <span className="text-[1rem] font-semibold">Most the pond may hold</span>
                <span className="flex items-center rounded-[18px] border border-line bg-field px-3.5 focus-within:border-accent">
                  <span className="text-ink-muted">$</span>
                  <input type="text" inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value.trim())}
                    className="min-h-12 w-full bg-transparent px-1.5 font-mono text-[1rem] outline-none" aria-invalid={!limitValid} />
                </span>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[1rem] font-semibold">Changes a day, at most</span>
                <select value={perDay} onChange={(event) => setPerDay(Number(event.target.value))}
                  className="min-h-12 rounded-[18px] border border-line bg-field px-3.5 text-[1rem] outline-none focus:border-accent">
                  {[1, 2, 3, 4, 6].map((count) => <option key={count} value={count}>{count}</option>)}
                </select>
              </label>
            </div>
            {!limitValid ? <p role="alert" className="text-[.9rem] text-danger">Enter a whole number of dollars.</p>
              : tooLow ? <p className="text-[.9rem] text-ink-muted">That's less than the pond holds now, so Tomo couldn't re-centre it.</p>
              : null}
          </>
        ) : null}

        <p className="text-[.9rem] leading-relaxed text-ink-muted">
          Tomo can only work this pond's pool and never sends money out of your Stillwater wallet. Each step is checked
          again before it's sent. You can turn this off any time.
        </p>

        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} disabled={saving}
            className="min-h-12 whitespace-nowrap rounded-full border border-line px-6 font-medium hover:bg-tint disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving || (mode !== "off" && !limitValid)}
            className="min-h-12 whitespace-nowrap rounded-full bg-accent px-7 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
