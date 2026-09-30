import { motion } from "motion/react";
import { Koi } from "../Icons";
import { formatPoolPrice } from "../../pages/ExplorePage";

type Props = {
  min: number;
  max: number;
  price: number;
  /** Labels under the band edges. */
  labels?: { min: string; max: string };
  size?: "large" | "small";
};

const BAND_LEFT = 16; // % of the width where the band starts (and ends, from the right)

/**
 * The band as a dashed pool of water and the koi as today's price. Inside the
 * band the koi swims in rings; outside it, it sits beyond the edge it crossed.
 */
export function KoiBand({ min, max, price, labels, size = "large" }: Props) {
  const width = 100 - BAND_LEFT * 2;
  const ratio = max > min ? (price - min) / (max - min) : 0.5;
  const inside = price >= min && price <= max;
  const left = inside ? BAND_LEFT + Math.min(0.92, Math.max(0.08, ratio)) * width
    : ratio < 0 ? BAND_LEFT / 2 : 100 - BAND_LEFT / 2;
  const large = size === "large";
  const where = inside ? "inside your band" : ratio < 0 ? "below your band" : "above your band";
  return (
    <div className="flex flex-col gap-2">
      {/* The small band sits in tight forms; the waves are only decoration. */}
      {large ? <Wave /> : null}
      <div className={`relative ${large ? "h-[200px]" : "h-[132px]"}`}
        role="img" aria-label={`Price ${formatPoolPrice(price)}, ${where} of ${formatPoolPrice(min)} to ${formatPoolPrice(max)}`}>
        <div className="absolute inset-y-[6%] rounded-full border-2 border-dashed border-band bg-band-fill"
          style={{ left: `${BAND_LEFT}%`, right: `${BAND_LEFT}%` }} />
        {/* layout: when the price moves, the koi glides to its new spot instead of jumping. */}
        <motion.div layout className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${left}%` }}>
          {inside ? (
            <div className={`flex items-center justify-center rounded-full border border-water ${large ? "size-[200px]" : "size-[128px]"}`}>
              <div className={`flex items-center justify-center rounded-full border-2 border-water bg-band-fill ${large ? "size-[132px]" : "size-[88px]"}`}>
                {/* Inside the band the koi sways a little, as if swimming in place. */}
                <motion.div
                  animate={{ transform: ["translateX(-3px) rotate(-2deg)", "translateX(3px) rotate(2deg)"] }}
                  transition={{ duration: 4, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" }}>
                  <Koi size={large ? 110 : 72} />
                </motion.div>
              </div>
            </div>
          ) : <Koi size={large ? 96 : 64} className="opacity-90" />}
        </motion.div>
      </div>
      <div className="relative h-6 text-[1.05rem] font-medium tabular-nums text-ink max-[520px]:text-[.9rem]">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${BAND_LEFT}%` }}>{labels?.min ?? `$${formatPoolPrice(min)}`}</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${100 - BAND_LEFT}%` }}>{labels?.max ?? `$${formatPoolPrice(max)}`}</span>
      </div>
      {large ? <Wave flip /> : null}
    </div>
  );
}

function Wave({ flip = false }: { flip?: boolean }) {
  return (
    <svg className="h-7 w-full text-water" viewBox="0 0 1000 28" preserveAspectRatio="none" aria-hidden="true">
      <path d={flip ? "M0 8 C 200 26, 360 2, 540 16 S 860 26, 1000 8" : "M0 20 C 160 4, 300 26, 470 12 S 800 2, 1000 18"}
        stroke="currentColor" strokeWidth="3" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
