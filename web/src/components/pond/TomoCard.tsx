import { useMemo, useState } from "react";
import { Tomo } from "../Icons";
import type { TomoNote } from "../../lib/ponds";

const SNOOZE_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (id: string) => `stillwater:tomo-snooze:${id}`;

function snoozedUntil(id: string): number {
  try {
    return Number(localStorage.getItem(snoozeKey(id)) ?? 0);
  } catch {
    return 0; // Storage blocked (private window): nothing is snoozed.
  }
}

type Props = {
  notes: TomoNote[];
  onOpenPond?: (note: TomoNote) => void;
};

/** Tomo's most useful note that isn't snoozed; "Remind me tomorrow" hides it for a day. */
export function TomoCard({ notes, onOpenPond }: Props) {
  const [snoozed, setSnoozed] = useState<string[]>([]);
  const [walking, setWalking] = useState(false);
  const note = useMemo(() => notes.find((entry) => !snoozed.includes(entry.id) && snoozedUntil(entry.id) < Date.now())
    ?? notes[notes.length - 1], [notes, snoozed]);
  if (!note) return null;

  const snooze = () => {
    try {
      localStorage.setItem(snoozeKey(note.id), String(Date.now() + SNOOZE_MS));
    } catch {
      // Without storage the note is hidden for this visit only.
    }
    setSnoozed((current) => [...current, note.id]);
    setWalking(false);
  };

  return (
    <section aria-labelledby="tomo-title" className="flex flex-col gap-5 rounded-[28px] border border-line bg-card p-[clamp(24px,3vw,36px)]">
      <div className="flex items-center gap-4">
        <Tomo size={72} sleepy={note.pond?.state !== "feeding"} />
        <div className="flex flex-col">
          <h2 id="tomo-title" className="text-[1.75rem] font-semibold">Tomo</h2>
          <span className="text-[1.05rem] text-ink-muted">a quiet note from your guide</span>
        </div>
      </div>
      <p aria-live="polite" className="text-[1.4rem] leading-snug font-medium">{note.message}</p>
      <p className="text-[1.1rem] leading-relaxed text-ink-muted">{note.advice}</p>
      {walking && note.steps.length > 0 ? (
        <ol className="flex list-decimal flex-col gap-2 pl-6 text-[1.05rem] leading-relaxed text-ink">
          {note.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {note.steps.length > 0 ? (
          walking && note.pond && onOpenPond ? (
            <button type="button" onClick={() => onOpenPond(note)}
              className="min-h-14 flex-auto rounded-full bg-accent px-6 text-[1.05rem] font-semibold text-on-accent hover:bg-accent-hover">
              Open the pool
            </button>
          ) : (
            <button type="button" onClick={() => setWalking(!walking)} aria-expanded={walking}
              className="min-h-14 flex-auto rounded-full bg-accent px-6 text-[1.05rem] font-semibold text-on-accent hover:bg-accent-hover">
              {walking ? "Got it" : "Walk me through it"}
            </button>
          )
        ) : null}
        {notes.length > 1 || note.steps.length > 0 ? (
          <button type="button" onClick={snooze}
            className="min-h-14 flex-auto rounded-full border border-line px-6 text-[1.05rem] font-medium text-ink hover:bg-tint">
            Remind me tomorrow
          </button>
        ) : null}
      </div>
    </section>
  );
}
