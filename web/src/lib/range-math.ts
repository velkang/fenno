export function tickToPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

export function priceToTick(price: number, dec0: number, dec1: number): number {
  if (price <= 0) return 0;
  return Math.round(Math.log(price / Math.pow(10, dec0 - dec1)) / Math.log(1.0001));
}

export function alignTick(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

function trimAmount(value: number, decimals: number): string {
  if (!(value > 0)) return "";
  return value.toLocaleString("en-US", {
    maximumSignificantDigits: 8,
    maximumFractionDigits: Math.min(decimals, 12),
    useGrouping: false,
  });
}

// Given one side of a deposit, returns the other side so both match the range at the
// current price. "token" is the listed token and "usdc" the quote; pool order may be either.
export function pairedAmount(input: {
  from: "token" | "usdc";
  value: string;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  spotPrice: number;
  tokenDecimals: number;
  usdcDecimals: number;
  usdcIsPoolToken0: boolean;
}): string {
  const num = Number.parseFloat(input.value.trim().replace(",", "."));
  if (Number.isNaN(num) || num <= 0 || !input.spotPrice) return "";
  const { currentTick, tickLower, tickUpper, usdcIsPoolToken0 } = input;
  // Outside the range the position holds only one asset.
  const belowRange = currentTick <= tickLower;
  const aboveRange = currentTick >= tickUpper;
  if (belowRange || aboveRange) {
    const heldIsUsdc = belowRange === usdcIsPoolToken0;
    return (input.from === "usdc") === heldIsUsdc ? "0" : "";
  }
  const sqrtP = Math.pow(1.0001, currentTick / 2);
  const deltaLower = sqrtP - Math.pow(1.0001, tickLower / 2);
  const sqrtPu = Math.pow(1.0001, tickUpper / 2);
  const deltaUpper = sqrtPu - sqrtP;
  // Raw pool-token1 per pool-token0 required at this range.
  const rawRatio = (sqrtP * sqrtPu * deltaLower) / deltaUpper;
  const usdcPerToken = usdcIsPoolToken0
    ? 1 / (rawRatio * Math.pow(10, input.usdcDecimals - input.tokenDecimals))
    : rawRatio * Math.pow(10, input.tokenDecimals - input.usdcDecimals);
  if (!Number.isFinite(usdcPerToken) || usdcPerToken <= 0) return "";
  return input.from === "token"
    ? trimAmount(num * usdcPerToken, input.usdcDecimals)
    : trimAmount(num / usdcPerToken, input.tokenDecimals);
}
