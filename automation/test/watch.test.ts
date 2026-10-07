import { describe, expect, it } from "vitest";
import { MIN, HOUR, emptyMemory, forSettings, observe, priceAgo, shouldAsk, triggerFor, type MandateMemory } from "../src/watch";

const NOW = 2_000_000_000_000;
const look = (memory: MandateMemory, minutesFromNow: number, price: number, inBand: boolean) =>
  observe(memory, { now: NOW + minutesFromNow * MIN, price, inBand });

describe("what makes the agent look", () => {
  it("asks once when a position is first watched, then once a day", () => {
    const first = look(emptyMemory(), 0, 1, true);
    expect(triggerFor(first, NOW)).toBe("daily_review");
    const reviewed = { ...first, lastReviewAt: NOW };
    expect(triggerFor(look(reviewed, 5, 1, true), NOW + 5 * MIN)).toBeNull();
    expect(triggerFor(look(reviewed, 24 * 60, 1, true), NOW + 24 * HOUR)).toBe("daily_review");
  });

  it("waits for the price to stay out of the band for two checks in a row", () => {
    let memory = { ...look(emptyMemory(), 0, 1, true), lastReviewAt: NOW };
    memory = look(memory, 5, 1.3, false);
    expect(triggerFor(memory, NOW + 5 * MIN)).toBeNull();
    memory = look(memory, 10, 1.3, false);
    expect(triggerFor(memory, NOW + 10 * MIN)).toBe("price_left_band");
    memory = look(memory, 15, 1, true);
    expect(triggerFor(memory, NOW + 15 * MIN)).toBeNull();
  });

  it("keeps a day of prices and finds the one nearest a time ago", () => {
    let memory = emptyMemory();
    for (let minute = 0; minute <= 26 * 60; minute += 5) memory = look(memory, minute, minute, true);
    const now = NOW + 26 * 60 * MIN;
    expect(memory.samples[0]!.at).toBeGreaterThanOrEqual(now - 25 * HOUR);
    expect(priceAgo(memory, now, HOUR)).toBe(26 * 60 - 60);
    expect(priceAgo(emptyMemory(), now, HOUR)).toBeNull();
  });
});

describe("when the agent holds back", () => {
  const base = { now: NOW, trigger: "price_left_band" as const, openRun: false, lastRunFinishedAt: null,
    runsStartedToday: 0, maxRunsPerDay: 2 };
  const memory = emptyMemory();

  it("asks when nothing stands in the way", () => {
    expect(shouldAsk({ ...base, memory })).toBe(true);
  });

  it("not while a proposal or run is open, the day's runs are used, or a run just ended", () => {
    expect(shouldAsk({ ...base, memory, openRun: true })).toBe(false);
    expect(shouldAsk({ ...base, memory, runsStartedToday: 2 })).toBe(false);
    expect(shouldAsk({ ...base, memory, lastRunFinishedAt: NOW - 30 * MIN })).toBe(false);
    expect(shouldAsk({ ...base, memory, lastRunFinishedAt: NOW - 2 * HOUR })).toBe(true);
  });

  it("not more than once an hour, and not about the same thing more than every six hours", () => {
    const asked = { ...memory, lastAskedAt: NOW - 30 * MIN, lastTrigger: "daily_review" as const };
    expect(shouldAsk({ ...base, memory: asked })).toBe(false);
    const sameAgain = { ...memory, lastAskedAt: NOW - 2 * HOUR, lastTrigger: "price_left_band" as const };
    expect(shouldAsk({ ...base, memory: sameAgain })).toBe(false);
    expect(shouldAsk({ ...base, memory: { ...sameAgain, lastAskedAt: NOW - 7 * HOUR } })).toBe(true);
    const different = { ...memory, lastAskedAt: NOW - 2 * HOUR, lastTrigger: "daily_review" as const };
    expect(shouldAsk({ ...base, memory: different })).toBe(true);
  });
});

describe("when the user changes Tomo's care", () => {
  it("looks again at the next check instead of waiting out the hour or six hours", () => {
    const saved = 1_000;
    const held: MandateMemory = { ...emptyMemory(), lastAskedAt: NOW - 30 * MIN, lastReviewAt: NOW - 30 * MIN,
      lastTrigger: "price_left_band", outsideChecks: 3, samples: [{ at: NOW - HOUR, price: 1 }], settingsSavedAt: saved };
    // The same settings as last time: nothing changes.
    expect(forSettings(held, saved)).toEqual(held);
    // Remembered from before settings were tracked: counts as a change, once.
    expect(forSettings({ ...held, settingsSavedAt: undefined }, saved)).toMatchObject({ lastAskedAt: 0, settingsSavedAt: saved });
    const changed = forSettings(held, saved + 1);
    expect(changed).toMatchObject({ lastAskedAt: 0, lastReviewAt: 0, lastTrigger: null, settingsSavedAt: saved + 1,
      outsideChecks: 3 });
    expect(changed.samples).toEqual(held.samples);
    expect(shouldAsk({ memory: changed, trigger: "price_left_band", now: NOW, openRun: false, lastRunFinishedAt: null,
      runsStartedToday: 0, maxRunsPerDay: 2 })).toBe(true);
  });
});
