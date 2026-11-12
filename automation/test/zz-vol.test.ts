import { it } from "vitest";
import { createPublicClient, fallback, http, getAddress, parseAbiItem } from "viem";
import { arc, UNISWAP_V4_ARC } from "@stillwater/chain";
it("cirBTC volume", async () => {
  const opts = { timeout: 30_000, retryCount: 4, retryDelay: 2000 };
  const client = createPublicClient({ chain: arc, transport: fallback([http("https://rpc.mainnet.arc.io", opts),
    http("https://rpc.blockdaemon.mainnet.arc.io", opts)]) });
  const latest = await client.getBlock();
  const from24 = latest.number! - BigInt(Math.round(1.97 * 86400));
  const v3swap = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
  const v4swap = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
  // cirBTC (8 dec) vs USDC: in v3 pool, USDC is token0 or 1 by address order.
  const cir = "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0".toLowerCase();
  const usdcErc = "0x3600000000000000000000000000000000000000";
  const v3pool = getAddress("0x82916bee18fCEF517B26C72d7Cb5F13694E1dB41");
  const usdcIsZero = usdcErc < cir;
  let n = 0, vol = 0, lo = Infinity, hi = 0, first = 0, last = 0; const rec = new Set<string>();
  for (let b = from24; b <= latest.number!; b += 2000n) {
    const to = b + 1999n > latest.number! ? latest.number! : b + 1999n;
    for (const l of await client.getLogs({ address: v3pool, event: v3swap, fromBlock: b, toBlock: to })) {
      const u = usdcIsZero ? l.args.amount0! : l.args.amount1!; vol += Math.abs(Number(u)) / 1e6; n++; rec.add(l.args.recipient!);
      const r = (Number(l.args.sqrtPriceX96!) / 2 ** 96) ** 2; // token1/token0 raw
      const p = usdcIsZero ? (1 / r) * 1e-2 * 1e0 : r * 1e8 / 1e6; // USD per cirBTC
      const price = usdcIsZero ? 1 / (r * 1e6 / 1e8) : r * 1e8 / 1e6; void p;
      if (!first) first = price; last = price; lo = Math.min(lo, price); hi = Math.max(hi, price);
    }
  }
  console.log("v3 cirBTC 0.01%", "swaps", n, "vol$", vol.toFixed(0), "recipients", rec.size, "price", first.toFixed(0), "->", last.toFixed(0), "range", lo.toFixed(0), "-", hi.toFixed(0));
  const ids = ["0xbb505cb19296", "0x2e6e7f11473f", "0x2524c1f36fea", "0x080d7ef18079"];
  const counts: Record<string, { n: number; rec: Set<string> }> = {};
  for (let b = from24; b <= latest.number!; b += 2000n) {
    const to = b + 1999n > latest.number! ? latest.number! : b + 1999n;
    for (const l of await client.getLogs({ address: UNISWAP_V4_ARC.poolManager, event: v4swap, fromBlock: b, toBlock: to })) {
      const key = l.args.id!.slice(0, 14);
      const c = counts[key] ?? { n: 0, rec: new Set() }; c.n++; c.rec.add(l.transactionHash); counts[key] = c;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  for (const [id, c] of top) console.log("v4 pool", id, "swaps", c.n, ids.includes(id) ? "(cirBTC)" : "");
  for (const id of ids) console.log("v4 cirBTC", id, "swaps", counts[id]?.n ?? 0);
}, 900_000);
