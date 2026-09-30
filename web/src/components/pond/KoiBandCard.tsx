import { LilyPad } from "../Icons";
import { formatUsd, type Pond } from "../../lib/ponds";
import { KoiBand } from "./KoiBand";

const STATE_TITLE: Record<Pond["state"], string> = {
  feeding: "Feeding",
  "resting-below": "Resting",
  "resting-above": "Resting",
};

/** The featured pond: its band, the koi at today's price, and what it has gathered. */
export function KoiBandCard({ pond }: { pond: Pond }) {
  const feeding = pond.state === "feeding";
  return (
    <article aria-label={`${pond.pair} pond`}
      className="flex flex-col gap-2 overflow-hidden rounded-[32px] bg-sage px-[clamp(20px,3.5vw,44px)] pt-9 pb-8">
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-base font-semibold tracking-[.04em] text-ink-muted">{pond.pair}</span>
          <span className={`text-[2.4rem] leading-tight font-semibold ${feeding ? "text-ink" : "text-rest"}`}>{STATE_TITLE[pond.state]}</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-base text-ink-muted">gathered so far</span>
          <span className="relative flex items-center">
            <LilyPad className="absolute -left-5 top-1.5" />
            <span className="relative text-[2.6rem] leading-none font-bold tabular-nums">{formatUsd(pond.gatheredUsd)}</span>
          </span>
        </div>
      </div>
      <KoiBand min={pond.min} max={pond.max} price={pond.price} />
      <p className="mt-1 font-hand text-[1.9rem] leading-snug text-hand max-[520px]:text-[1.5rem]">
        {feeding
          ? "the koi is today's price. while it swims in your band, you earn."
          : "the koi has left your band. it earns again when it swims back in."}
      </p>
    </article>
  );
}
