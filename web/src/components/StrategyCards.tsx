import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatPoolPrice } from "../pages/ExplorePage";

export type StrategyKey = "conservative" | "balanced" | "focused";

type Props = {
  selected: StrategyKey;
  spotPrice: number;
  onSelect: (strategy: StrategyKey) => void;
  /** Only the selected band shows; clicking it calls `onExpand` to choose again. */
  collapsed?: boolean;
  onExpand?: () => void;
};

export const STRATEGIES: { key: StrategyKey; name: string; spread: number; label: string; hint: string }[] = [
  { key: "conservative", name: "Wide", spread: 0.25, label: "±25%",
    hint: "Keeps earning through big price swings. Earns less per trade." },
  { key: "balanced", name: "Balanced", spread: 0.1, label: "±10%",
    hint: "A middle ground for most people." },
  { key: "focused", name: "Narrow", spread: 0.03, label: "±3%",
    hint: "Earns the most per trade, but rests after small moves." },
];

export const StrategyCards: React.FC<Props> = ({ selected, spotPrice, onSelect, collapsed = false, onExpand }) => (
  <div className={`relative grid gap-3 ${collapsed ? "grid-cols-1" : "grid-cols-3 max-[680px]:grid-cols-1"}`}
    role={collapsed ? undefined : "radiogroup"} aria-label={collapsed ? undefined : "Band width"}>
    <AnimatePresence initial={false} mode="popLayout">
      {STRATEGIES.filter((strategy) => !collapsed || strategy.key === selected).map((strategy) => {
        const isSelected = selected === strategy.key;
        const floor = spotPrice * (1 - strategy.spread);
        const ceiling = spotPrice * (1 + strategy.spread);
        return (
          <motion.button key={strategy.key} type="button" layout
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            // Motion corrects a radius it can see during layout animations; a class would stretch.
            style={{ borderRadius: 20 }}
            {...(collapsed
              ? { "aria-label": `${strategy.name} ${strategy.label}, change band`, disabled: !onExpand, onClick: onExpand }
              : { role: "radio", "aria-checked": isSelected, onClick: () => onSelect(strategy.key) })}
            className={`flex min-w-0 flex-col gap-2 px-5 py-4 text-left text-ink transition-colors ${isSelected
              ? "border-2 border-ink bg-card" : "border border-band hover:bg-card/60"}`}>
            <motion.span layout="position" className="flex items-center justify-between gap-2 text-[1.2rem] font-semibold">
              <span>{strategy.name}</span>
              <span className="tabular-nums">{strategy.label}</span>
            </motion.span>
            <motion.span layout="position" className="text-[.98rem] leading-snug whitespace-normal text-ink-muted">{strategy.hint}</motion.span>
            <motion.span layout="position" className="text-[.9rem] whitespace-normal text-ink-faint tabular-nums">
              ${formatPoolPrice(floor)} – ${formatPoolPrice(ceiling)}
            </motion.span>
            {collapsed ? <span className="text-[.95rem] font-semibold text-link">Change band</span> : null}
          </motion.button>
        );
      })}
    </AnimatePresence>
  </div>
);
