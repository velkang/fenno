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
  { id: "off", name: "Off", line: "Pip leaves this pond to you." },
  { id: "ask", name: "Ask me first", line: "Pip suggests a change and waits for you to approve it." },
  { id: "autopilot", name: "Autopilot", line: "Pip makes the change and tells you afterwards." },
];
const BANDS: { id: BandChoice; name: string }[] = [
  { id: "agent", name: "Pip chooses" },
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
  // A re-centre reopens the band with what it holds now plus its fees, and Tomo keeps 10% room for the
  // price moving meanwhile. A limit below that would leave Tomo unable to ever re-centre this pond.
  const heldUsd = pond.valueUsd === null ? null : pond.valueUsd + (pond.gatheredUsd ?? 0);
  const neededUsd = heldUsd === null ? null : Math.max(1, Math.ceil(heldUsd * 1.1));
  const tooLow = limitValid && neededUsd !== null && limitUsd < neededUsd;

  const save = async () => {
    setSaving(true);
    try {
      if (mode === "off") {
        if (mandate) await api.revokeMandate(mandate.id);
        onSaved(`Pip won't change your ${pond.symbol} pond.`);
        return;
      }
      await api.saveMandate({ poolId: pond.poolId, mode, band, maxPositionUsd: limitUsd, maxRunsPerDay: perDay });
      onSaved(mode === "ask"
        ? `Pip will suggest changes to your ${pond.symbol} pond for you to approve.`
        : `Pip will look after your ${pond.symbol} pond and tell you what it did.`);
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
          <h2 id="care-title" className="text-[1.7rem] font-semibold">Let Pip look after your {pond.symbol} pond</h2>
          <p className="text-[1.05rem] leading-relaxed text-ink-muted">
            Pip moves this pond when the price leaves its band.
          </p>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-[1rem] font-semibold">What Pip may do</legend>
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
              : tooLow ? (
                <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[.9rem] text-danger">
                  <span>This pond holds about ${heldUsd!.toFixed(2)}, so with a ${limitUsd} limit Pip could never re-centre it.
                    It needs at least ${neededUsd}.</span>
                  <button type="button" onClick={() => setLimit(String(Math.max(neededUsd!, suggestedLimit)))}
                    className="min-h-10 whitespace-nowrap font-semibold text-link underline underline-offset-4">
                    Use ${Math.max(neededUsd!, suggestedLimit)}
                  </button>
                </div>
              ) : null}
          </>
        ) : null}

        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} disabled={saving}
            className="min-h-12 whitespace-nowrap rounded-full border border-line px-6 font-medium hover:bg-tint disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving || (mode !== "off" && (!limitValid || tooLow))}
            className="min-h-12 whitespace-nowrap rounded-full bg-accent px-7 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
