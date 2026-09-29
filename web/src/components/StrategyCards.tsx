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
    hint: "Earns the most per trade, but stops earning after small moves." },
];

export const StrategyCards: React.FC<Props> = ({ selected, spotPrice, onSelect }) => (
  <div className="mt-0.5 grid grid-cols-3 gap-2 max-[680px]:gap-1.5" role="radiogroup" aria-label="Price range">
    {STRATEGIES.map((strategy) => {
      const isSelected = selected === strategy.key;
      const floor = spotPrice * (1 - strategy.spread);
      const ceiling = spotPrice * (1 + strategy.spread);

      return (
        <div className="min-w-0" key={strategy.key}>
          <button
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(strategy.key)}
            className={`grid min-h-[75px] w-full cursor-pointer content-center gap-2 rounded-[9px] border px-2.5 py-[9px] text-left text-[#e5ebf3] transition-[background-color,border-color] duration-140 ease-[ease] max-[680px]:min-h-[69px] max-[680px]:gap-1.5 max-[680px]:px-[7px] max-[680px]:py-2 ${isSelected
              ? "border-[#10b981] bg-[#063c32] shadow-[inset_0_0_0_1px_#10b981]"
              : "border-[#344256] bg-[#151e2b] hover:border-[#607187]"}`}
          >
            <span className="flex min-w-0 items-center gap-2 text-[.8rem] whitespace-nowrap max-[680px]:gap-[5px] max-[680px]:text-[.72rem]">
              <span className={`inline-grid size-[17px] flex-none place-items-center rounded-full border max-[680px]:size-[15px] ${isSelected
                ? "border-[#6ee7b7] after:size-2 after:rounded-full after:bg-[#10b981]"
                : "border-[#65758b]"}`} aria-hidden="true" />
              <span>{strategy.name}</span>
            </span>
            <strong className={`pl-[25px] text-[.9rem] font-[550] max-[680px]:pl-5 max-[680px]:text-[.83rem] ${isSelected ? "text-[#34d399]" : "text-[#aebbd0]"}`}>{strategy.label}</strong>
          </button>
          <p className="mt-1.5 mb-0 text-center text-[.73rem] text-[#b6c1d1] tabular-nums max-[680px]:text-[.65rem]">${formatPoolPrice(floor)} – ${formatPoolPrice(ceiling)}</p>
          <p className="mt-1 mb-0 text-center text-[.7rem] leading-[1.35] whitespace-normal text-[#8190a5] tabular-nums">{strategy.hint}</p>
        </div>
      );
    })}
  </div>
);
