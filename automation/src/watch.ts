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
  return { ...memory, outsideChecks: look.inBand ? 0 : memory.outsideChecks + 1, samples };
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
}): boolean {
  const { memory, trigger, now } = input;
  if (input.openRun || input.runsStartedToday >= input.maxRunsPerDay) return false;
  if (input.lastRunFinishedAt !== null && now - input.lastRunFinishedAt < COOLDOWN_AFTER_RUN_MS) return false;
  if (now - memory.lastAskedAt < MIN_ASK_GAP_MS) return false;
  if (trigger === memory.lastTrigger && now - memory.lastAskedAt < SAME_TRIGGER_GAP_MS) return false;
  return true;
}

/** Records that the model was asked: an ask is also a review. */
export function asked(memory: MandateMemory, trigger: Trigger, now: number): MandateMemory {
  return { ...memory, lastAskedAt: now, lastTrigger: trigger, lastReviewAt: now };
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
