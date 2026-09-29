import { defineChain, getAddress, http, type Address, type Hex } from "viem";

// Both keyless Arc endpoints (Circle and QuickNode) rate-limit at about 20 calls
// per second, shared per client IP and counting each call inside a batch.
const RPC_CALLS_PER_WINDOW = 20;
const RPC_WINDOW_MS = 1_100;

/**
 * HTTP transport that sends calls issued in the same tick as one JSON-RPC batch
 * (Cloudflare's free plan allows 50 subrequests per invocation) and paces them
 * under the endpoints' rate limit. Waiting costs wall time, not CPU time.
 * One retry: each retry is another subrequest.
 */
// Without a URL, viem uses the chain's default RPC (Arc's public endpoint).
export function arcRpcTransport(url?: string) {
  let queue: Promise<void> = Promise.resolve();
  let windowStart = 0;
  let sentInWindow = 0;
  const pacedFetch: typeof fetch = (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const calls = body.startsWith("[") ? body.split('"jsonrpc"').length - 1 : 1;
    queue = queue.then(async () => {
      if (Date.now() - windowStart >= RPC_WINDOW_MS) { windowStart = Date.now(); sentInWindow = 0; }
      if (sentInWindow > 0 && sentInWindow + calls > RPC_CALLS_PER_WINDOW) {
        await new Promise((resolve) => setTimeout(resolve, windowStart + RPC_WINDOW_MS - Date.now()));
        windowStart = Date.now();
        sentInWindow = 0;
      }
      sentInWindow += calls;
    });
    return queue.then(() => fetch(input, init));
  };
  return http(url, { batch: { batchSize: RPC_CALLS_PER_WINDOW }, retryCount: 1, fetchFn: pacedFetch });
}

export const ARC_CHAIN_ID = 5_042;
const USDC_INTERFACE_SCALE = 1_000_000_000_000n;

export function canSpendArcUsdc(nativeBalance18: bigint, amount6: bigint, feeReserve18: bigint): boolean {
  return nativeBalance18 >= 0n && amount6 >= 0n && feeReserve18 >= 0n &&
    nativeBalance18 >= amount6 * USDC_INTERFACE_SCALE + feeReserve18;
}

export function maxArcUsdcAmount(nativeBalance18: bigint, feeReserve18: bigint): bigint {
  return nativeBalance18 > feeReserve18 ? (nativeBalance18 - feeReserve18) / USDC_INTERFACE_SCALE : 0n;
}

export const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.arc.io"],
      webSocket: ["wss://rpc.mainnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

type VerifiedContract = {
  address: Address;
  codeSize: number;
  bytecodeHash: Hex;
};

export const ARC_TOKENS = {
  USDC: {
    address: getAddress("0x3600000000000000000000000000000000000000"),
    symbol: "USDC",
    decimals: 6,
  },
  cirBTC: {
    address: getAddress("0x171a4217b86a807A64eB94757db6849Fb4BdBaA0"),
    symbol: "cirBTC",
    decimals: 8,
  },
} as const;

export const UNISWAP_V3_ARC = {
  factory: {
    address: getAddress("0xf0db7b58379503491d857dB50AC9ece64c653918"),
    codeSize: 24_535,
    bytecodeHash:
      "0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d",
  },
  nonfungiblePositionManager: {
    address: getAddress("0x39654a85a4C05127F5FD6Ed22CaeC077A0FB1377"),
    codeSize: 24_384,
    bytecodeHash:
      "0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0",
  },
} as const satisfies Record<string, VerifiedContract>;

export const UNISWAP_SWAP_ARC = {
  swapRouter02: getAddress("0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77"),
  quoterV2: getAddress("0x7dfd4f31be6814d2906bde155c3e1b146eac1468"),
} as const;

// Official Uniswap deployment manifest for Arc (chain 5042).
export const UNISWAP_V4_ARC = {
  poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  positionManager: getAddress("0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"),
  quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  stateView: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
} as const;

export const UNISWAP_SHARED_ARC = {
  universalRouter: {
    address: getAddress("0x8702463e73f74d0b6765aBceb314Ef07aCb92650"),
    codeSize: 24_380,
    bytecodeHash:
      "0x2e80a35dc8a1da121611acc5c31be03c2e63669135461e63947901ecf8a1654d",
  },
  permit2: {
    address: getAddress("0x000000000022d473030f116ddeE9F6B43ac78Ba3"),
    codeSize: 9_152,
    bytecodeHash:
      "0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f",
  },
} as const satisfies Record<string, VerifiedContract>;

export const ALPHA_POOL = {
  protocol: "uniswap-v3",
  address: getAddress("0x82916BeE18fcef517b26c72d7CB5F13694E1Db41"),
  bytecodeHash:
    "0xba38545defface0c20f10c45bc5b78bcdf30aac6a805583e6a3d424200f4fc89" as Hex,
  codeSize: 22_142,
  token0: ARC_TOKENS.cirBTC,
  token1: ARC_TOKENS.USDC,
  fee: 100,
  tickSpacing: 1,
} as const;

export const ERC20_INTERFACE_USDC_CODE = {
  address: ARC_TOKENS.USDC.address,
  codeSize: 1_798,
  bytecodeHash:
    "0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d" as Hex,
} as const;
