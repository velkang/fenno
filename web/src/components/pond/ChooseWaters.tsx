import type { Waters } from "@stillwater/chain";
import { WaterMark } from "../Icons";

export const WATERS: { id: Waters; name: string; line: string; tag: string; tone: string }[] = [
  { id: "still", name: "Still water", line: "Stablecoin pairs. Calm, small, steady.", tag: "gentle", tone: "text-feed" },
  { id: "gentle", name: "Gentle stream", line: "Established tokens like cirBTC and WETH. Some movement, more fees.", tag: "moderate", tone: "text-rest" },
  { id: "rapids", name: "Rapids", line: "New tokens. Big fees, big swings, real losses.", tag: "rough", tone: "text-danger" },
];

/** The three kinds of pool, each opening Explore filtered to it. */
export function ChooseWaters({ onChoose }: { onChoose: (waters: Waters) => void }) {
  return (
    <section aria-labelledby="waters-title" className="flex flex-col">
      <h2 id="waters-title" className="mb-4 text-[2rem] font-semibold">Choose your waters</h2>
      {WATERS.map((water) => (
        <button key={water.id} type="button" onClick={() => onChoose(water.id)}
          className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-4 border-t border-line py-6 text-left transition-colors hover:bg-tint/60">
          <WaterMark tier={water.id} className={water.tone} />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-[1.3rem] font-semibold">{water.name}</span>
            <span className="text-[1.05rem] leading-snug whitespace-normal text-ink-muted">{water.line}</span>
          </span>
          <span className={`text-[1.05rem] font-semibold ${water.tone}`}>{water.tag}</span>
        </button>
      ))}
    </section>
  );
}
