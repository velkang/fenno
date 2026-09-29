import React, { useMemo } from "react";
import { formatPoolPrice } from "../pages/ExplorePage";

type Props = {
  minPrice: number;
  maxPrice: number;
  spotPrice: number;
  token0Symbol: string;
  token1Symbol: string;
};

function formatCurrency(value: number): string {
  return `$${formatPoolPrice(value)}`;
}

export const MeteoraRangeBar: React.FC<Props> = ({
  minPrice,
  maxPrice,
  spotPrice,
  token0Symbol,
  token1Symbol,
}) => {
  const isInRange = spotPrice >= minPrice && spotPrice <= maxPrice;
  const spotPercentage = useMemo(() => {
    if (minPrice >= maxPrice) return 50;
    const ratio = (spotPrice - minPrice) / (maxPrice - minPrice);
    return Math.max(3, Math.min(97, ratio * 100));
  }, [minPrice, maxPrice, spotPrice]);

  const bins = useMemo(() => {
    const count = 24;
    return Array.from({ length: count }, (_, index) => {
      const distance = Math.abs(index - (count - 1) / 2) / ((count - 1) / 2);
      return Math.max(16, Math.round(92 * Math.exp(-distance * distance * 3.2)));
    });
  }, []);

  return (
    <div className="px-[5px] pt-px pb-0">
      <div
        className="relative mt-1.5 h-[182px] px-2 pt-7 pb-0 max-[680px]:h-40"
        role="img"
        aria-label={`Price range from ${formatCurrency(minPrice)} to ${formatCurrency(maxPrice)}. Spot price ${formatCurrency(spotPrice)} is ${isInRange ? "in range" : "out of range"}. Below the floor the position holds ${token0Symbol}; above the ceiling it holds ${token1Symbol}.`}
      >
        <div className="absolute right-2.5 bottom-[17px] left-2.5 flex h-[78%] items-end justify-between gap-1" aria-hidden="true">
          {bins.map((height, index) => (
            <span
              key={index}
              className="w-[4%] max-w-[15px] min-w-1 rounded-t-[2px] bg-[#059669] opacity-[.88]"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
        <div
          className="absolute top-0 bottom-4 z-1 w-0"
          style={{ left: `${spotPercentage}%` }}
          aria-hidden="true"
        >
          <span className="absolute top-0 left-1/2 grid min-w-max gap-0 text-center text-[#f59e0b] [transform:translateX(-50%)]">
            <span className="text-[.76rem]">Price now</span>
            <strong className="text-base font-[650] tabular-nums">{formatCurrency(spotPrice)}</strong>
          </span>
          <span className="absolute top-11 bottom-0 -left-0.5 w-1 bg-[#f59e0b]" />
          <span className="absolute -bottom-1 -left-[5px] size-2.5 rounded-full bg-[#f59e0b]" />
        </div>
        <div className="absolute right-0 bottom-3.5 left-0 h-px bg-[#8593a8]" aria-hidden="true" />
        <div className="absolute right-1.5 bottom-1 left-1.5 flex justify-between" aria-hidden="true">
          {Array.from({ length: 15 }, (_, index) => <span key={index} className="h-[7px] w-px bg-[#66758a]" />)}
        </div>
      </div>

      <div className="mx-0.5 mt-0 mb-[18px] flex justify-between gap-2 text-[.78rem] text-[#b6c1d1]">
        <div className="grid gap-px">
          <span>Stops earning below</span>
          <strong className="text-[.91rem] font-semibold text-[#f3f4f6] tabular-nums">{formatCurrency(minPrice)}</strong>
        </div>
        <div className="grid gap-px text-center">
          <span>Price now</span>
          <strong className="text-[.91rem] font-semibold text-[#f3f4f6] tabular-nums">{formatCurrency(spotPrice)}</strong>
        </div>
        <div className="grid gap-px text-right">
          <span>Stops earning above</span>
          <strong className="text-[.91rem] font-semibold text-[#f3f4f6] tabular-nums">{formatCurrency(maxPrice)}</strong>
        </div>
      </div>
    </div>
  );
};
