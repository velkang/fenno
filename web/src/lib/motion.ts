// Timings and presets for Stillwater's motion, so every part of the app moves the same calm way.
// The app root's MotionConfig (reducedMotion="user") turns transform and layout animation off
// for anyone who asks their system for less motion.

/** Layout and movement: settles without overshoot, since this is money. */
export const SPRING = { type: "spring", bounce: 0, visualDuration: 0.35 } as const;

/** Opacity-only changes. */
export const FADE = { duration: 0.2, ease: "easeOut" } as const;

/** Appears and disappears in place. */
export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: FADE,
} as const;

/** Rises slightly as it appears: dialogs and newly loaded content. */
export const lift = {
  initial: { opacity: 0, transform: "translateY(8px)" },
  animate: { opacity: 1, transform: "none" },
  exit: { opacity: 0, transform: "translateY(8px)" },
} as const;

/** Side panels and drawers that come in from the right edge. */
export const slideFromRight = {
  initial: { transform: "translateX(100%)" },
  animate: { transform: "none" },
  exit: { transform: "translateX(100%)" },
} as const;

/** Rows that open and close in place, like an accordion. Pair with overflow-hidden. */
export const reveal = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;
