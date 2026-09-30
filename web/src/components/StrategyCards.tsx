import React from "react";
import { formatPoolPrice } from "../pages/ExplorePage";

export type StrategyKey = "conservative" | "balanced" | "focused";

type Props = {
  selected: StrategyKey;
  spotPrice: number;
  onSelect: (strategy: StrategyKey) => void;
};

export const STRATEGIES: { key: StrategyKey; name: string; spread: number; label: string; hint: string }[] = [
  { key: "conservative", name: "Wide", spread: 0.25, label: "±25%",
    hint: "Keeps earning through big price swings. Earns less per trade." },
  { key: "balanced", name: "Balanced", spread: 0.1, label: "±10%",
    hint: "A middle ground for most people." },
  { key: "focused", name: "Narrow", spread: 0.03, label: "±3%",
    hint: "Earns the most per trade, but rests after small moves." },
];

export const StrategyCards: React.FC<Props> = ({ selected, spotPrice, onSelect }) => (
  <div className="grid grid-cols-3 gap-3 max-[680px]:grid-cols-1" role="radiogroup" aria-label="Band width">
    {STRATEGIES.map((strategy) => {
      const isSelected = selected === strategy.key;
      const floor = spotPrice * (1 - strategy.spread);
      const ceiling = spotPrice * (1 + strategy.spread);
      return (
        <button key={strategy.key} type="button" role="radio" aria-checked={isSelected} onClick={() => onSelect(strategy.key)}
          className={`flex min-w-0 flex-col gap-2 rounded-[20px] px-5 py-4 text-left text-ink transition-colors ${isSelected
            ? "border-2 border-ink bg-card" : "border border-band hover:bg-card/60"}`}>
          <span className="flex items-center justify-between gap-2 text-[1.2rem] font-semibold">
            <span>{strategy.name}</span><span className="tabular-nums">{strategy.label}</span>
          </span>
          <span className="text-[.98rem] leading-snug whitespace-normal text-ink-muted">{strategy.hint}</span>
          <span className="text-[.9rem] whitespace-normal text-ink-faint tabular-nums">${formatPoolPrice(floor)} – ${formatPoolPrice(ceiling)}</span>
        </button>
      );
    })}
  </div>
);
