// When the agent looks at a position. Code watches every few minutes for free; the model is
// asked only when something has changed, and not so often that it churns or runs up a bill.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const WATCH_MS = 5 * MIN;

// No "pool is draining" trigger: v4 reports only the liquidity active at the current price,
// which drops whenever the price crosses a tick, so it would mislead the model. The daily
// review catches a real drain within a day.
export type Trigger = "price_left_band" | "daily_review";

type Sample = { at: number; price: number };

/** What the watcher remembers about one mandate's position between checks. */
export type MandateMemory = {
  outsideChecks: number;
  lastReviewAt: number;
  lastAskedAt: number;
  lastTrigger: Trigger | null;
  /** About a day of prices, one sample per check. */
  samples: Sample[];
  /** When the user last saved this mandate, as last seen. */
  settingsSavedAt?: number;
  /** The price when the model was last asked. */
  lastAskedPrice?: number;
  /** When the price left the band, while it stays out. */
  outsideSince?: number;
};

const KEEP_SAMPLES_MS = 25 * HOUR;
const REVIEW_MS = 24 * HOUR;
const MIN_ASK_GAP_MS = HOUR;
const SAME_TRIGGER_GAP_MS = 6 * HOUR;
const COOLDOWN_AFTER_RUN_MS = HOUR;

export function emptyMemory(): MandateMemory {
  // Never reviewed, so the first check asks once: a first look when the user turns it on.
  return { outsideChecks: 0, lastReviewAt: 0, lastAskedAt: 0, lastTrigger: null, samples: [] };
}

/**
 * New care settings (limit, mode, band) mean a fresh look: forget when the model was last asked,
 * so the next check asks again instead of waiting out the hour or six hours. Prices are kept.
 */
export function forSettings(memory: MandateMemory, savedAt: number): MandateMemory {
  if (memory.settingsSavedAt === savedAt) return memory;
  return { ...memory, lastAskedAt: 0, lastReviewAt: 0, lastTrigger: null, settingsSavedAt: savedAt };
}

export function observe(memory: MandateMemory, look: { now: number; price: number; inBand: boolean }): MandateMemory {
  const samples = [...memory.samples, { at: look.now, price: look.price }]
    .filter((sample) => sample.at >= look.now - KEEP_SAMPLES_MS);
  return { ...memory, outsideChecks: look.inBand ? 0 : memory.outsideChecks + 1, samples,
    outsideSince: look.inBand ? undefined : memory.outsideSince ?? look.now };
}

export function triggerFor(memory: MandateMemory, now: number): Trigger | null {
  if (memory.outsideChecks >= 2) return "price_left_band";
  if (now - memory.lastReviewAt >= REVIEW_MS) return "daily_review";
  return null;
}

export function shouldAsk(input: {
  memory: MandateMemory;
  trigger: Trigger;
  now: number;
  openRun: boolean;
  lastRunFinishedAt: number | null;
  runsStartedToday: number;
  maxRunsPerDay: number;
  /** The price now and the position's band, to tell whether the price has moved further out. */
  priceUsd?: number;
  band?: { minUsd: number; maxUsd: number };
}): boolean {
  const { memory, trigger, now } = input;
  if (input.openRun || input.runsStartedToday >= input.maxRunsPerDay) return false;
  if (input.lastRunFinishedAt !== null && now - input.lastRunFinishedAt < COOLDOWN_AFTER_RUN_MS) return false;
  // A price running further away is worth asking about at once, even after a "hold".
  if (trigger === "price_left_band" && movedFurtherOut(memory, input.priceUsd, input.band)) return true;
  if (now - memory.lastAskedAt < MIN_ASK_GAP_MS) return false;
  // While out of the band, the hourly gap is enough; a daily review needn't repeat for six hours.
  if (trigger === "daily_review" && trigger === memory.lastTrigger && now - memory.lastAskedAt < SAME_TRIGGER_GAP_MS) {
    return false;
  }
  return true;
}

/** The price is at least half a band's width further outside the band than when the model was last asked. */
function movedFurtherOut(memory: MandateMemory, priceUsd?: number, band?: { minUsd: number; maxUsd: number }): boolean {
  if (priceUsd === undefined || !band || memory.lastAskedPrice === undefined || memory.lastTrigger !== "price_left_band") {
    return false;
  }
  const outside = (price: number) => (price < band.minUsd ? band.minUsd - price : price > band.maxUsd ? price - band.maxUsd : 0);
  return outside(priceUsd) - outside(memory.lastAskedPrice) >= (band.maxUsd - band.minUsd) / 2;
}

/** Records that the model was asked: an ask is also a review. */
export function asked(memory: MandateMemory, trigger: Trigger, now: number, priceUsd?: number): MandateMemory {
  return { ...memory, lastAskedAt: now, lastTrigger: trigger, lastReviewAt: now, lastAskedPrice: priceUsd };
}

/** The price recorded nearest to `ago` before now, if one is within 15 minutes of it. */
export function priceAgo(memory: MandateMemory, now: number, ago: number): number | null {
  const target = now - ago;
  let best: Sample | null = null;
  for (const sample of memory.samples) {
    if (Math.abs(sample.at - target) <= 15 * MIN && (!best || Math.abs(sample.at - target) < Math.abs(best.at - target))) {
      best = sample;
    }
  }
  return best ? best.price : null;
}
