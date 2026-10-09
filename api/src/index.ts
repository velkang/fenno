import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { BaseError, ContractFunctionRevertedError, createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  ARC_WATERS,
  UNISWAP_V3_ARC,
  UNISWAP_V4_ARC,
  UNISWAP_SHARED_ARC,
  UNISWAP_SWAP_ARC,
  approvalPayloadHash,
  mintPayloadHash,
  arcV4MintPayloadHash,
  buildArcV4PositionAction,
  arcV4PositionActionPayloadHash,
  readArcV4Position,
  v4MintedTokenIds,
  arc,
  arcRpcTransport,
  buildApproval,
  buildMint,
  buildArcV4Mint,
  buildArcV4Approval,
  buildArcV4Swap,
  arcV4ApprovalPayloadHash,
  arcV4SwapPayloadHash,
  readArcV4Allowances,
  buildCollectAll,
  buildDecreaseLiquidity,
  buildFullWithdrawal,
  buildIncreaseLiquidity,
  buildUsdcWithdrawal,
  buildTokenWithdrawal,
  tokenWithdrawalMessage,
  tokenWithdrawalPayloadHash,
  tokenWithdrawalTypes,
  buildSwap,
  canSpendArcUsdc,
  maxArcUsdcAmount,
  MAX_PRICE_IMPACT_BPS,
  MIN_POOL_DEPTH_USD,
  poolDepthUsd,
  priceImpactBps,
  managerAbi,
  readWalletSummary,
  quoteSwap,
  quoteArcV4Swap,
  readArcV4Pool,
  readArcV4PositionFees,
  discoverArcTokenPools,
  positionActionPayloadHash,
  simulateApproval,
  simulateMint,
  simulatePositionAction,
  swapPayloadHash,
  withdrawalDomain,
  withdrawalMessage,
  withdrawalPayloadHash,
  withdrawalTypes,
  verifyV3Position,
  type ApprovalSimulationClient,
  type ChainReadClient,
  type Mint,
  type PoolDiscoveryClient,
  type PositionActionClient,
  PERMIT2_APPROVAL_SECONDS,
} from "@stillwater/chain";
import {
  AuthError,
  hashOpaqueValue,
  issueChallenge,
  verifyChallenge,
  type AuthStore,
  type AuthUser,
} from "./auth";
import { agentIdentity, registerAutomationRoutes, type AgentRun } from "./automation";
import { D1AuthStore } from "./d1-auth-store";
import { D1IndexerHealthStore, getIndexerHealth } from "./indexer-health";

const SESSION_COOKIE = "stillwater_session";

export type Bindings = {
  DB: D1Database;
  SIGNER: Fetcher;
  // The web app's URL; SIWE messages are bound to its host.
  AUTH_URI: string;
  AUTH_COOKIE_SECURE?: string;
  // Optional override; without it, Arc's default public RPC is used.
  ARC_RPC_URL?: string;
  // The indexer's private discovery endpoint; a pasted token address is looked up through it.
  INDEXER?: Fetcher;
  // Shared with the automation Worker; its requests act for one wallet under a mandate.
  AGENT_SECRET?: string;
  // The automation Worker: starts and steps through re-centring runs.
  AUTOMATION?: Fetcher;
};

type Variables = {
  authStore: AuthStore;
  user: AuthUser;
  sessionTokenHash: string;
  // Set when the automation Worker makes the request (see automation.ts).
  agentRun: AgentRun | undefined;
};

export type AppEnvironment = { Bindings: Bindings; Variables: Variables };
type AppDependencies = {
  createAuthStore?: (env: Bindings) => AuthStore;
  createChainClient?: (env: Bindings) => ChainReadClient;
  now?: () => number;
};

type ApprovalRouteClient = ApprovalSimulationClient & {
  getBlock(parameters: { blockTag: "safe" }): Promise<{
    number: bigint | null;
    hash: Hex | null;
  }>;
};
type PositionRouteClient = ApprovalRouteClient & PositionActionClient;

type PoolDirectoryRow = {
  pool_address: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  token0_address: string;
  token1_address: string;
  fee: number;
  tick_spacing: number;
  sqrt_price_x96: string;
  tick: number;
  liquidity: string;
  usdc_reserve: string;
  block_number: number;
  updated_at: number;
};

type V4PoolDirectoryRow = {
  pool_id: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tick_spacing: number;
  hooks: Address;
  token_address: Address;
  token_symbol: string;
  token_decimals: number;
  sqrt_price_x96: string;
  tick: number;
  liquidity: string;
  lp_fee: number;
  block_number: number;
  updated_at: number;
};

type CombinedPoolRow = {
  protocol: "uniswap-v3" | "uniswap-v4";
  address: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  token0: string;
  token1: string;
  fee: number;
  tick_spacing: number;
  sqrt_price_x96: string;
  tick: number;
  liquidity: string;
  usdc_reserve: string | null;
  hooks: string | null;
  lp_fee: number | null;
  block_number: number;
  updated_at: number;
  created_block: number | null;
};

const poolTokenAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);
const usdcBalanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const swapTokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

function publicPool(row: PoolDirectoryRow) {
  return {
    protocol: "uniswap-v3" as const,
    address: row.pool_address,
    token: { address: row.token_address, symbol: row.token_symbol, decimals: row.token_decimals },
    token0: row.token0_address,
    token1: row.token1_address,
    fee: row.fee,
    tickSpacing: row.tick_spacing,
    sqrtPriceX96: row.sqrt_price_x96,
    tick: row.tick,
    liquidity: row.liquidity,
    usdcReserve: row.usdc_reserve,
    blockNumber: row.block_number as number | null,
    updatedAt: row.updated_at,
  };
}

function publicV4Pool(row: V4PoolDirectoryRow) {
  return {
    protocol: "uniswap-v4" as const,
    address: row.pool_id,
    token: { address: row.token_address, symbol: row.token_symbol, decimals: row.token_decimals },
    token0: row.currency0,
    token1: row.currency1,
    fee: row.fee,
    tickSpacing: row.tick_spacing,
    sqrtPriceX96: row.sqrt_price_x96,
    tick: row.tick,
    liquidity: row.liquidity,
    lpFee: row.lp_fee,
    hooks: row.hooks,
    usdcReserve: null,
    blockNumber: row.block_number as number | null,
    updatedAt: row.updated_at,
  };
}

function publicCombinedPool(row: CombinedPoolRow) {
  return {
    protocol: row.protocol,
    address: row.address,
    token: { address: row.token_address, symbol: row.token_symbol,
      decimals: row.token_decimals },
    token0: row.token0,
    token1: row.token1,
    fee: row.fee,
    tickSpacing: row.tick_spacing,
    sqrtPriceX96: row.sqrt_price_x96,
    tick: row.tick,
    liquidity: row.liquidity,
    usdcReserve: row.usdc_reserve,
    ...(row.protocol === "uniswap-v4" ? { hooks: row.hooks ?? undefined,
      lpFee: row.lp_fee ?? undefined } : {}),
    blockNumber: row.block_number as number | null,
    updatedAt: row.updated_at,
    createdBlock: row.created_block ?? null,
  };
}

const v3PoolStateAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
]);
const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
type MulticallClient = {
  multicall(input: { contracts: unknown[]; allowFailure: true }): Promise<Array<{ status: string; result?: unknown }>>;
};

/** Listed pools with their current on-chain price and liquidity, in one multicall. */
async function withLiveState(client: MulticallClient, pools: ReturnType<typeof publicCombinedPool>[]) {
  const contracts = pools.flatMap((pool): unknown[] => pool.protocol === "uniswap-v4"
    ? [{ address: UNISWAP_V4_ARC.stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [pool.address] },
      { address: UNISWAP_V4_ARC.stateView, abi: v4StateViewAbi, functionName: "getLiquidity", args: [pool.address] }]
    : [{ address: pool.address, abi: v3PoolStateAbi, functionName: "slot0" },
      { address: pool.address, abi: v3PoolStateAbi, functionName: "liquidity" },
      { address: ARC_TOKENS.USDC.address, abi: usdcBalanceAbi, functionName: "balanceOf", args: [pool.address] }]);
  if (contracts.length === 0) return pools;
  const results = await client.multicall({ contracts, allowFailure: true });
  let index = 0;
  return pools.map((pool) => {
    const count = pool.protocol === "uniswap-v4" ? 2 : 3;
    const [slot0, liquidity, reserve] = results.slice(index, index += count);
    const sqrtPriceX96 = slot0?.status === "success" ? (slot0.result as readonly [bigint, number])[0] : 0n;
    if (sqrtPriceX96 === 0n || liquidity?.status !== "success") return pool;
    return { ...pool, sqrtPriceX96: sqrtPriceX96.toString(),
      tick: Number((slot0!.result as readonly [bigint, number])[1]), liquidity: String(liquidity.result),
      ...(reserve?.status === "success" ? { usdcReserve: String(reserve.result) } : {}) };
  });
}

/** Asks the indexer to find and store a token's USDC pools; true when any were found. */
async function discoverTokenPools(env: Bindings, tokenAddress: Address): Promise<boolean> {
  if (!env.INDEXER) return false;
  const response = await env.INDEXER.fetch(new Request("http://stillwater-indexer/internal/v1/pools/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenAddress }),
  }));
  if (!response.ok) {
    console.warn("Token pool discovery failed", tokenAddress, response.status);
    return false;
  }
  const { found } = await response.json() as { found: number };
  return found > 0;
}

async function livePublicPools(client: PoolDiscoveryClient, tokenAddress: Address) {
  const discovery = await discoverArcTokenPools({ client, tokenAddress });
  return Promise.all(discovery.pools.filter((pool) => BigInt(pool.liquidity) > 0n).map(async (pool) => {
    const balance = await client.readContract({
      address: ARC_TOKENS.USDC.address,
      abi: usdcBalanceAbi,
      functionName: "balanceOf",
      args: [pool.address],
    });
    return {
      protocol: "uniswap-v3" as const,
      address: pool.address,
      token: discovery.token,
      token0: pool.token0.address,
      token1: pool.token1.address,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing,
      sqrtPriceX96: pool.sqrtPriceX96,
      tick: pool.tick,
      liquidity: pool.liquidity,
      usdcReserve: String(balance),
      blockNumber: null,
      updatedAt: Date.now(),
    };
  }));
}

async function jsonBody(context: Context<AppEnvironment>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new AuthError("INVALID_JSON", 400);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("INVALID_REQUEST", 400);
  }
  return value as Record<string, unknown>;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<AppEnvironment>();
  const now = dependencies.now ?? Date.now;

  async function mintedV4Positions(env: Bindings, wallet: { id: string; address: Address }, offset = 0) {
    // One query joins each mint to its directory row, so D1 is not queried per NFT.
    const rows = await env.DB.prepare(
      `SELECT mta.transaction_hash, vmi.intent_id, vmi.token_id, vmi.pool_id AS minted_pool_id, vpd.*
       FROM v4_mint_intents vmi
       JOIN wallet_intents wi ON wi.id = vmi.intent_id
       JOIN mainnet_transaction_attempts mta ON mta.intent_id = wi.id
       LEFT JOIN v4_pool_directory vpd ON vpd.pool_id = vmi.pool_id
       WHERE wi.wallet_id = ?1 AND wi.status = 'confirmed' AND mta.status = 'confirmed'
       ORDER BY mta.submitted_at DESC LIMIT 50 OFFSET ?2`,
    ).bind(wallet.id, offset).all<{ transaction_hash: Hex; intent_id: string; token_id: string | null;
      minted_pool_id: Hex } &
      (V4PoolDirectoryRow | { [K in keyof V4PoolDirectoryRow]: null })>();
    const client = (dependencies.createChainClient?.(env) ??
      createPublicClient({ chain: arc, transport: arcRpcTransport(env.ARC_RPC_URL), batch: { multicall: true } })) as unknown as
      ChainReadClient & { getTransactionReceipt(input: { hash: Hex }): Promise<{
        logs: { address: Address; topics: readonly Hex[]; data: Hex }[];
      }>;
      getBlock(input: { blockTag: "latest" }): Promise<{ number: bigint | null }> };
    const block = await client.getBlock({ blockTag: "latest" });
    if (block.number === null) throw new Error("Arc block unavailable");
    const blockNumber = block.number;
    const recorded: D1PreparedStatement[] = [];
    const found = await Promise.all((rows.results ?? []).map(async (row) => {
      let ids: bigint[];
      if (row.token_id !== null) {
        ids = [BigInt(row.token_id)];
      } else {
        // Mints confirmed before token ids were recorded: the RPC prunes old receipts, so an
        // unreadable one hides only that mint, and a readable one is recorded for next time.
        try {
          ids = v4MintedTokenIds((await client.getTransactionReceipt({ hash: row.transaction_hash })).logs,
            wallet.address);
        } catch { return []; }
        if (ids.length === 1) {
          recorded.push(env.DB.prepare(
            "UPDATE v4_mint_intents SET token_id = ?2 WHERE intent_id = ?1 AND token_id IS NULL",
          ).bind(row.intent_id, ids[0].toString()));
        }
      }
      return Promise.all(ids.map(async (tokenId) => {
        try {
          const position = await readArcV4Position({ client, tokenId, owner: wallet.address,
            blockNumber });
          if (position.poolId.toLowerCase() !== row.minted_pool_id.toLowerCase()) return null;
          if (row.pool_id === null) return null;
          const { transaction_hash: _hash, intent_id: _intent, token_id: _token, minted_pool_id: _minted,
            ...pool } = row;
          const [live, fees] = await Promise.all([
            readArcV4Pool({ client, key: position.poolKey, blockNumber }),
            // Uncollected fees are shown, not acted on: a failed read shows as unknown.
            readArcV4PositionFees({ client, poolId: position.poolId, tokenId, tickLower: position.tickLower,
              tickUpper: position.tickUpper, blockNumber }).catch(() => null),
          ]);
          if (!live) return null;
          return { tokenId: tokenId.toString(), pool: publicV4Pool({ ...pool,
            sqrt_price_x96: live.sqrtPriceX96, tick: live.tick,
            liquidity: live.liquidity, lp_fee: live.lpFee,
            block_number: Number(blockNumber), updated_at: now() }),
            tickLower: position.tickLower, tickUpper: position.tickUpper,
            liquidity: position.liquidity.toString(), transactionHash: row.transaction_hash,
            fees: fees ? { amount0: fees.amount0.toString(), amount1: fees.amount1.toString() } : null };
        } catch { return null; } // Burned or transferred NFTs are no longer wallet positions.
      }));
    }));
    // Recording is a cache: a failed write only means the receipt is read again next time.
    if (recorded.length > 0) await env.DB.batch(recorded).catch(() => undefined);
    return { positions: found.flat().filter((value): value is NonNullable<typeof value> => value !== null),
      hasMore: (rows.results ?? []).length === 50 };
  }

  app.use("/v1/*", async (context, next) => {
    context.set(
      "authStore",
      dependencies.createAuthStore?.(context.env) ??
        new D1AuthStore(context.env.DB),
    );
    await next();
  });

  app.onError((error, context) => {
    if (error instanceof AuthError) {
      return context.json({ error: error.code }, error.status as 400);
    }
    console.error(error);
    return context.json({ error: "INTERNAL_ERROR" }, 500);
  });

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.get("/health/indexer", async (context) => {
    const health = await getIndexerHealth(
      new D1IndexerHealthStore(context.env.DB),
      { now },
    );
    return context.json(health.body, health.httpStatus);
  });

  app.get("/v1/pools", async (context) => {
    // Listings are shared by every visitor, so they are cached briefly at the edge.
    const cache = typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(context.req.url, { method: "GET" });
    const cached = await cache?.match(cacheKey).catch(() => undefined);
    if (cached) return cached;
    const query = (context.req.query("q") ?? "").trim().slice(0, 80);
    const offsetValue = Number(context.req.query("offset") ?? "0");
    const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? Math.min(offsetValue, 10_000) : 0;
    // "Waters" narrows the list by how calm a token's pools tend to be (ARC_WATERS).
    const watersParam = context.req.query("waters");
    const waters = watersParam === "still" || watersParam === "gentle" || watersParam === "rapids" ? watersParam : "";
    const calmTokens = JSON.stringify(waters === "rapids" ? [...ARC_WATERS.still, ...ARC_WATERS.gentle]
      : waters ? ARC_WATERS[waters] : []);
    // D1 bills every row read, so each kind of request reads through an index:
    // - browsing walks each table's created_block index and SQLite merges the two, so a page
    //   reads about as many rows as it returns (in DESC order NULL created_block sorts last);
    // - a pasted token or pool address is an equality lookup;
    // - a symbol matches from its start, as a range on the symbol index (a "contains" LIKE
    //   read every pool).
    const addressQuery = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(query);
    const match = (keyColumn: string) => query === "" ? ""
      : addressQuery ? `AND (token_address = ?1 OR ${keyColumn} = ?1)`
        : "AND token_symbol COLLATE NOCASE >= ?1 AND token_symbol COLLATE NOCASE < ?2";
    const filters = (keyColumn: string) => `liquidity != '0' ${match(keyColumn)}
         AND (?4 = '' OR (?4 = 'rapids') != (lower(token_address) IN (SELECT lower(value) FROM json_each(?5))))`;
    const selectPools = () => context.env.DB.prepare(
      `SELECT 'uniswap-v3' AS protocol, pool_address AS address,
         token_address, token_symbol, token_decimals,
         token0_address AS token0, token1_address AS token1,
         fee, tick_spacing, sqrt_price_x96, tick, liquidity,
         usdc_reserve, NULL AS hooks, NULL AS lp_fee, block_number, updated_at, created_block
       FROM pool_directory
       WHERE ${filters("pool_address")}
       UNION ALL
       SELECT 'uniswap-v4' AS protocol, pool_id AS address,
         token_address, token_symbol, token_decimals,
         currency0 AS token0, currency1 AS token1,
         fee, tick_spacing, sqrt_price_x96, tick, liquidity,
         NULL AS usdc_reserve, hooks, lp_fee, block_number, updated_at, created_block
       FROM v4_pool_directory
       WHERE ${filters("pool_id")}
       ORDER BY created_block DESC, token_symbol COLLATE NOCASE, fee, address
       LIMIT 26 OFFSET ?3`,
      // ?2 is the end of the symbol range: the search text followed by the highest character.
    ).bind(query, `${query}\u{10FFFF}`, offset, waters, calmTokens)
      .all<CombinedPoolRow>();
    let rows = await selectPools();
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as
      PoolDiscoveryClient & MulticallClient;
    if (isAddress(query) && rows.results.length === 0 && getAddress(query) !== ARC_TOKENS.USDC.address) {
      // A pasted token address the directory does not list yet: the indexer looks it up on chain now.
      const address = getAddress(query);
      try {
        let found = await discoverTokenPools(context.env, address);
        if (!found) {
          // A pasted v3 pool address: discover its token, whose pools include it.
          const [token0, token1] = await Promise.all(["token0", "token1"].map((functionName) =>
            client.readContract({ address, abi: poolTokenAbi, functionName })));
          if (token0 === ARC_TOKENS.USDC.address || token1 === ARC_TOKENS.USDC.address) {
            found = await discoverTokenPools(context.env,
              getAddress(token0 === ARC_TOKENS.USDC.address ? token1 as string : token0 as string));
          }
        }
        if (found) rows = await selectPools();
      } catch (error) {
        console.warn("Contract address search failed", query, error);
        // A contract address with no eligible pools is an empty result, not a server failure.
      }
    }
    let pools = rows.results.slice(0, 25).map(publicCombinedPool);
    try {
      // The stored liquidity flag is refreshed only about once a day, so a pool drained since
      // then is dropped here from its live value: it cannot be traded, and a quote for it fails.
      pools = (await withLiveState(client, pools)).filter((pool) => pool.liquidity !== "0");
    } catch (error) {
      console.warn("Live pool state unavailable; listing stored state", error);
    }
    const response = context.json({ pools, nextOffset: rows.results.length > 25 ? offset + 25 : null });
    response.headers.set("Cache-Control", "public, max-age=10");
    if (cache) {
      try {
        context.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
      } catch {
        // No execution context (tests): nothing to cache into.
      }
    }
    return response;
  });

  app.get("/v1/pools/:poolAddress", async (context) => {
    const requested = context.req.param("poolAddress");
    if (/^0x[0-9a-fA-F]{64}$/.test(requested)) {
      const row = await context.env.DB.prepare(
        "SELECT * FROM v4_pool_directory WHERE pool_id = ?1",
      ).bind(requested).first<V4PoolDirectoryRow>();
      if (!row) return context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);
      const client = (dependencies.createChainClient?.(context.env) ??
        createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as ChainReadClient;
      try {
        const live = await readArcV4Pool({ client, key: { currency0: getAddress(row.currency0),
          currency1: getAddress(row.currency1), fee: row.fee, tickSpacing: row.tick_spacing,
          hooks: getAddress(row.hooks) } });
        if (!live || live.id.toLowerCase() !== row.pool_id.toLowerCase()) {
          return context.json({ error: "POOL_NOT_AVAILABLE" }, 404);
        }
        return context.json({ pool: { ...publicV4Pool(row), sqrtPriceX96: live.sqrtPriceX96,
          tick: live.tick, liquidity: live.liquidity, lpFee: live.lpFee,
          blockNumber: null, updatedAt: Date.now() } });
      } catch (error) {
        console.error("Pool read failed", requested, error);
        return context.json({ error: "POOL_NOT_AVAILABLE" }, 502);
      }
    }
    if (!isAddress(requested)) return context.json({ error: "INVALID_POOL_ADDRESS" }, 400);
    const address = getAddress(requested);
    const row = await context.env.DB.prepare(
      "SELECT * FROM pool_directory WHERE pool_address = ?1",
    ).bind(address).first<PoolDirectoryRow>();
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as PoolDiscoveryClient;
    try {
      let tokenAddress: Address;
      if (row) tokenAddress = getAddress(row.token_address);
      else {
        const [token0, token1] = await Promise.all(["token0", "token1"].map((functionName) =>
          client.readContract({ address, abi: poolTokenAbi, functionName })));
        tokenAddress = getAddress(token0 === ARC_TOKENS.USDC.address ? token1 as string : token0 as string);
        if (token0 !== ARC_TOKENS.USDC.address && token1 !== ARC_TOKENS.USDC.address) {
          return context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);
        }
      }
      const pools = await livePublicPools(client, tokenAddress);
      const pool = pools.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase());
      return pool ? context.json({ pool }) : context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);
    } catch (error) {
      console.error("Pool read failed", address, error);
      return context.json({ error: "POOL_NOT_AVAILABLE" }, 502);
    }
  });

  app.post("/v1/auth/challenge", async (context) => {
    const body = record(await jsonBody(context));
    const challenge = await issueChallenge(
      context.get("authStore"),
      { address: body.address },
      {
        chainId: ARC_CHAIN_ID,
        domain: new URL(context.env.AUTH_URI).host,
        uri: context.env.AUTH_URI,
      },
      { now },
    );
    return context.json(challenge, 201);
  });

  app.post("/v1/auth/verify", async (context) => {
    const body = record(await jsonBody(context));
    const result = await verifyChallenge(
      context.get("authStore"),
      {
        challengeId: body.challengeId,
        message: body.message,
        signature: body.signature,
      },
      { now },
    );
    setCookie(context, SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      maxAge: Math.floor((result.sessionExpiresAt - now()) / 1_000),
      path: "/",
      sameSite: "Strict",
      secure: context.env.AUTH_COOKIE_SECURE !== "false",
    });
    return context.json({
      user: result.user,
      sessionExpiresAt: result.sessionExpiresAt,
    });
  });

  app.use("/v1/*", agentIdentity());
  app.use("/v1/me", requireSession(now));
  app.use("/v1/auth/logout", requireSession(now));
  app.use("/v1/wallets/*", requireSession(now));
  app.use("/v1/automation/*", requireSession(now));
  registerAutomationRoutes(app, now, (env) => (dependencies.createChainClient?.(env) ??
    createPublicClient({ chain: arc, transport: http(env.ARC_RPC_URL), batch: { multicall: true } })) as ChainReadClient);

  app.get("/v1/me", (context) => context.json({ user: context.get("user") }));

  app.post("/v1/auth/logout", async (context) => {
    await context
      .get("authStore")
      .deleteSession(context.get("sessionTokenHash"));
    deleteCookie(context, SESSION_COOKIE, { path: "/" });
    return context.body(null, 204);
  });

  app.post("/v1/wallets/provision", async (context) => {
    const user = context.get("user");
    const response = await context.env.SIGNER.fetch(
      new Request("http://stillwater-signer/internal/v1/wallets/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          walletId: `wallet_${user.id}`,
        }),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.get("/v1/wallets/me", async (context) => {
    const wallet = await context.env.DB.prepare(
      `SELECT id, address, state, created_at, updated_at
       FROM managed_wallets WHERE user_id = ?1`,
    )
      .bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string; created_at: number; updated_at: number }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);

    // Auto-reconcile any pending submitted attempt
    const pendingAttempt = await context.env.DB.prepare(
      "SELECT id FROM mainnet_transaction_attempts WHERE wallet_id = ?1 AND status = 'submitted' LIMIT 1",
    )
      .bind(wallet.id)
      .first<{ id: string }>();

    if (pendingAttempt) {
      try {
        await context.env.SIGNER.fetch(
          new Request("http://stillwater-signer/internal/v1/attempts/reconcile-mainnet", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attemptId: pendingAttempt.id }),
          }),
        );
      } catch (err) {
        console.warn("Wallet refresh auto-reconciliation error", err);
      }
    }

    return context.json({ wallet });
  });

  app.get("/v1/wallets/summary", async (context) => {
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    )
      .bind(context.get("user").id)
      .first<{ id: string; address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    // Anyone can send a position to a wallet. Only positions in pools this wallet opened
    // a position in through Stillwater are shown as the user's own.
    const opened = await context.env.DB.prepare(
      `SELECT DISTINCT mi.token0_address, mi.token1_address, mi.fee
       FROM wallet_intents wi JOIN mint_intents mi ON mi.intent_id = wi.id
       WHERE wi.wallet_id = ?1 AND wi.status = 'confirmed' AND wi.kind = 'position_mint'
         AND mi.token0_address IS NOT NULL AND mi.token1_address IS NOT NULL AND mi.fee IS NOT NULL`,
    ).bind(wallet.id).all<{ token0_address: Address; token1_address: Address; fee: number }>();
    const pools = (opened.results ?? []).map((row) =>
      ({ token0: row.token0_address, token1: row.token1_address, fee: row.fee }));

    const client =
      dependencies.createChainClient?.(context.env) ??
      (createPublicClient({
        chain: arc,
        transport: arcRpcTransport(context.env.ARC_RPC_URL),
        batch: { multicall: true },
      }) as unknown as ChainReadClient);
    try {
      return context.json({
        summary: await readWalletSummary(client, wallet.address, { pools }),
      });
    } catch (error) {
      console.error("Arc wallet summary read failed", error);
      return context.json({ error: "CHAIN_READ_FAILED" }, 502);
    }
  });

  app.get("/v1/wallets/assets", async (context) => {
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address }>();
    if (!wallet) throw new AuthError("WALLET_NOT_FOUND", 404);
    const rows = await context.env.DB.prepare(
      `SELECT token_address AS address, token_symbol AS symbol, token_decimals AS decimals
       FROM mint_intents mi JOIN wallet_intents wi ON wi.id = mi.intent_id
       WHERE wi.wallet_id = ?1 AND token_address IS NOT NULL
       UNION
       SELECT si.token_address AS address,
         COALESCE((SELECT pd.token_symbol FROM pool_directory pd
           WHERE pd.token_address = si.token_address LIMIT 1), 'Token') AS symbol,
         si.token_decimals AS decimals
       FROM swap_intents si JOIN wallet_intents wi ON wi.id = si.intent_id
       WHERE wi.wallet_id = ?1
       UNION
       SELECT vpd.token_address AS address, vpd.token_symbol AS symbol, vpd.token_decimals AS decimals
       FROM v4_pool_directory vpd
       WHERE vpd.pool_id IN (
         SELECT vsi.pool_id FROM v4_swap_intents vsi JOIN wallet_intents wi ON wi.id = vsi.intent_id
         WHERE wi.wallet_id = ?1
         UNION
         SELECT vmi.pool_id FROM v4_mint_intents vmi JOIN wallet_intents wi ON wi.id = vmi.intent_id
         WHERE wi.wallet_id = ?1)
       LIMIT 30`,
    ).bind(wallet.id).all<{ address: Address; symbol: string; decimals: number }>();
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as PoolDiscoveryClient;
    const unique = [...new Map(rows.results.map((row) => [row.address.toLowerCase(), row])).values()];
    const assets = await Promise.all(unique.map(async (row) => {
      if (!isAddress(row.address) || row.address.toLowerCase() === ARC_TOKENS.USDC.address.toLowerCase()) return null;
      try {
        const raw = await client.readContract({ address: getAddress(row.address), abi: swapTokenAbi,
          functionName: "balanceOf", args: [wallet.address] });
        return typeof raw === "bigint" && raw > 0n && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 36
          ? { address: row.address, symbol: row.symbol, decimals: row.decimals, raw: raw.toString() } : null;
      } catch { return null; }
    }));
    return context.json({ assets: assets.filter((asset) => asset !== null) });
  });

  app.get("/v1/wallets/tokens/:tokenAddress/balance", async (context) => {
    let tokenAddress: Address;
    try {
      tokenAddress = getAddress(context.req.param("tokenAddress"));
    } catch {
      throw new AuthError("INVALID_TOKEN_ADDRESS", 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    ).bind(context.get("user").id).first<{ id: string; address: Address }>();
    if (!wallet) throw new AuthError("WALLET_NOT_FOUND", 404);
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: arcRpcTransport(context.env.ARC_RPC_URL) })) as PoolDiscoveryClient;
    try {
      const raw = await client.readContract({ address: tokenAddress, abi: swapTokenAbi,
        functionName: "balanceOf", args: [wallet.address] });
      return context.json({ balance: String(raw) });
    } catch (error) {
      console.error("Token balance read failed", tokenAddress, error);
      return context.json({ error: "BALANCE_UNAVAILABLE" }, 502);
    }
  });

  app.get("/v1/wallets/tokens/:tokenAddress/pools", async (context) => {
    const rawAddress = context.req.param("tokenAddress");
    let tokenAddress: Address;
    try {
      tokenAddress = getAddress(rawAddress);
    } catch {
      throw new AuthError("INVALID_TOKEN_ADDRESS", 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT address FROM managed_wallets WHERE user_id = ?1 AND state != 'closed'",
    )
      .bind(context.get("user").id)
      .first<{ address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    const client = (
      dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })
    ) as unknown as PoolDiscoveryClient;
    try {
      const result = await discoverArcTokenPools({
        client,
        tokenAddress,
        owner: wallet.address,
      });
      return context.json({
        token: result.token,
        usdc: result.usdc,
        pools: result.pools,
        liability: "Fenno does not validate or endorse this token. You are responsible for the contract address and liquidity decision.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "USDC cannot be used as the supplied token") {
        throw new AuthError("TOKEN_NOT_ALLOWED", 400);
      }
      if (message === "Token address has no contract bytecode") {
        throw new AuthError("TOKEN_NOT_FOUND", 422);
      }
      console.warn("Arc token pool discovery failed", tokenAddress, error);
      return context.json({ error: "POOL_DISCOVERY_FAILED" }, 502);
    }
  });

  async function loadSwap(context: Context<AppEnvironment>, body: Record<string, unknown>) {
    if (typeof body.tokenAddress !== "string" || !isAddress(body.tokenAddress) ||
      typeof body.poolAddress !== "string" || !isAddress(body.poolAddress) ||
      (body.direction !== "buy" && body.direction !== "sell") ||
      typeof body.amountIn !== "string" || !/^[1-9][0-9]*$/.test(body.amountIn)) {
      throw new AuthError("INVALID_SWAP_REQUEST", 400);
    }
    const tokenAddress = getAddress(body.tokenAddress);
    const poolAddress = getAddress(body.poolAddress);
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) throw new AuthError("WALLET_NOT_FOUND", 404);
    if (wallet.state !== "active") throw new AuthError("WALLET_NOT_ACTIVE", 409);
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as PoolDiscoveryClient & ApprovalRouteClient & {
        getBalance(input: { address: Address }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      };
    const block = await client.getBlock({ blockTag: "safe" });
    if (block.number === null) throw new AuthError("ARC_SAFE_BLOCK_UNAVAILABLE", 503);
    const discovery = await discoverArcTokenPools({ client, tokenAddress,
      owner: wallet.address, blockNumber: block.number });
    const pool = discovery.pools.find((candidate) => candidate.address.toLowerCase() === poolAddress.toLowerCase());
    if (!pool || BigInt(pool.liquidity) === 0n) throw new AuthError("POOL_NOT_ELIGIBLE", 422);
    const tokenIn = body.direction === "buy" ? ARC_TOKENS.USDC.address : tokenAddress;
    const tokenOut = body.direction === "buy" ? tokenAddress : ARC_TOKENS.USDC.address;
    const amountIn = BigInt(body.amountIn);
    const [quoted, allowance, balance, nativeBalance] = await Promise.all([
      quoteSwap({ client: client as unknown as Parameters<typeof quoteSwap>[0]["client"], pool,
        account: wallet.address, tokenIn, tokenOut, amountIn, blockNumber: block.number })
        .catch((error: unknown) => {
          if (error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError)) {
            throw new AuthError("POOL_QUOTE_UNAVAILABLE", 422);
          }
          throw error;
        }),
      client.readContract({ address: tokenIn, abi: swapTokenAbi, functionName: "allowance",
        args: [wallet.address, UNISWAP_SWAP_ARC.swapRouter02], blockNumber: block.number }),
      client.readContract({ address: tokenIn, abi: swapTokenAbi, functionName: "balanceOf",
        args: [wallet.address], blockNumber: block.number }),
      client.getBalance({ address: wallet.address }),
    ]);
    if (typeof allowance !== "bigint" || typeof balance !== "bigint") {
      throw new AuthError("TOKEN_READ_FAILED", 502);
    }
    if (balance < amountIn) throw new AuthError("INSUFFICIENT_TOKEN_BALANCE", 422);
    // An almost empty pool fills a trade at a ruinous price: refuse before anything is prepared.
    const impactBps = priceImpactBps({ sqrtPriceX96: pool.sqrtPriceX96, zeroForOne: tokenIn === pool.token0.address,
      amountIn, amountOut: quoted.amountOut, feePips: pool.fee });
    if (impactBps > MAX_PRICE_IMPACT_BPS) throw new AuthError("PRICE_IMPACT_TOO_HIGH", 422);
    return { wallet, client, blockNumber: block.number, discovery, pool,
      tokenIn, tokenOut, amountIn, quoted, allowance, nativeBalance, impactBps };
  }

  app.post("/v1/wallets/swaps/quote", async (context) => {
    const body = record(await jsonBody(context));
    const swap = await loadSwap(context, body);
    const slippageBps = body.slippageBps === undefined ? 100 : body.slippageBps;
    if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) ||
      slippageBps < 0 || slippageBps > 500) throw new AuthError("INVALID_SLIPPAGE", 400);
    return context.json({
      poolAddress: swap.pool.address,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      amountIn: swap.amountIn.toString(),
      expectedAmountOut: swap.quoted.amountOut.toString(),
      minimumAmountOut: (swap.quoted.amountOut * BigInt(10_000 - slippageBps) / 10_000n).toString(),
      allowance: swap.allowance.toString(),
      nativeBalance: swap.nativeBalance.toString(),
      priceImpactBps: swap.impactBps,
      blockNumber: swap.blockNumber.toString(),
    });
  });

  app.post("/v1/wallets/swaps/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const swap = await loadSwap(context, body);
    const slippageBps = body.slippageBps;
    if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) ||
      slippageBps < 0 || slippageBps > 500 ||
      typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
      body.idempotencyKey.length > 200) throw new AuthError("INVALID_SWAP_REQUEST", 400);
    if (swap.allowance < swap.amountIn) throw new AuthError("ROUTER_APPROVAL_REQUIRED", 409);
    const deadline = BigInt(Math.floor(now() / 1_000) + 10 * 60);
    const built = buildSwap({
      poolAddress: swap.pool.address,
      poolFee: swap.pool.fee,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      recipient: swap.wallet.address,
      amountIn: swap.amountIn,
      amountOutMinimum: swap.quoted.amountOut * BigInt(10_000 - slippageBps) / 10_000n,
      deadline,
    });
    const [gas, fees] = await Promise.all([
      swap.client.estimateGas({ account: swap.wallet.address, to: built.to,
        data: built.data, value: 0n, blockNumber: swap.blockNumber }),
      swap.client.estimateFeesPerGas(),
    ]);
    const feeReserve = (gas * 120n * fees.maxFeePerGas + 99n) / 100n;
    if (!canSpendArcUsdc(swap.nativeBalance,
      swap.tokenIn === ARC_TOKENS.USDC.address ? swap.amountIn : 0n, feeReserve)) {
      throw new AuthError("INSUFFICIENT_USDC_AFTER_FEES", 422);
    }
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    const existing = await context.env.DB.prepare(
      `SELECT id, status FROM wallet_intents WHERE wallet_id = ?1
       AND kind = 'single_pool_swap' AND idempotency_key_hash = ?2`,
    ).bind(swap.wallet.id, idempotencyKeyHash).first<{ id: string; status: string }>();
    if (existing) return context.json({ intentId: existing.id, status: existing.status, existing: true });
    const intentId = `swap_${crypto.randomUUID()}`;
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents
         (id, wallet_id, kind, payload_hash, status, expires_at, created_at, updated_at, idempotency_key_hash,
          automation_run_id)
         VALUES (?1, ?2, 'single_pool_swap', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
      ).bind(intentId, swap.wallet.id, swapPayloadHash(built), Number(deadline) * 1_000,
        timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO swap_intents
         (intent_id, chain_id, pool_address, token_address, token_decimals, fee,
          token_in, token_out, recipient, amount_in, amount_out_minimum, deadline, calldata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      ).bind(intentId, ARC_CHAIN_ID, built.poolAddress, swap.discovery.token.address,
        swap.discovery.token.decimals, built.fee, built.tokenIn, built.tokenOut,
        built.recipient, built.amountIn.toString(), built.amountOutMinimum.toString(),
        Number(deadline), built.data, timestamp),
    ]);
    return context.json({ intentId, status: "pending", gasEstimate: gas.toString(),
      expectedAmountOut: swap.quoted.amountOut.toString(),
      minimumAmountOut: built.amountOutMinimum.toString() }, 201);
  });

  app.post("/v1/wallets/withdrawals/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.recipient !== "string" || !isAddress(body.recipient) ||
      typeof body.amount !== "string" || !/^[1-9][0-9]*$/.test(body.amount) ||
      typeof body.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.nonce) ||
      typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature) ||
      typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) ||
      (body.token !== undefined && (typeof body.token !== "string" || !isAddress(body.token)))) {
      throw new AuthError("INVALID_WITHDRAWAL", 400);
    }
    // Any token but USDC: the owner signs which token too. USDC keeps its own format and fee reserve.
    const otherToken = typeof body.token === "string" && getAddress(body.token) !== ARC_TOKENS.USDC.address
      ? getAddress(body.token) : null;
    const timestamp = now();
    if (body.expiresAt <= Math.floor(timestamp / 1_000) + 30 ||
      body.expiresAt > Math.floor(timestamp / 1_000) + 5 * 60) {
      throw new AuthError("WITHDRAWAL_AUTHORIZATION_EXPIRED", 400);
    }
    const wallet = await context.env.DB.prepare(
      `SELECT mw.id, mw.address, mw.state, u.owner_address
       FROM managed_wallets mw JOIN users u ON u.id = mw.user_id
       WHERE mw.user_id = ?1`,
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string; owner_address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active" && wallet.state !== "paused") {
      return context.json({ error: "WALLET_NOT_ACTIONABLE" }, 409);
    }
    const request = {
      wallet: wallet.address,
      recipient: getAddress(body.recipient),
      amount: BigInt(body.amount),
      nonce: body.nonce as Hex,
      expiresAt: BigInt(body.expiresAt),
    };
    let withdrawal;
    let tokenWithdrawal;
    try {
      if (otherToken) tokenWithdrawal = buildTokenWithdrawal({ ...request, token: otherToken });
      else withdrawal = buildUsdcWithdrawal(request);
    } catch {
      throw new AuthError("INVALID_WITHDRAWAL", 400);
    }
    const transfer = (tokenWithdrawal ?? withdrawal)!;
    const validSignature = await (tokenWithdrawal
      ? verifyTypedData({ address: wallet.owner_address, domain: withdrawalDomain, types: tokenWithdrawalTypes,
        primaryType: "TokenWithdrawal", message: tokenWithdrawalMessage(tokenWithdrawal), signature: body.signature as Hex })
      : verifyTypedData({ address: wallet.owner_address, domain: withdrawalDomain, types: withdrawalTypes,
        primaryType: "UsdcWithdrawal", message: withdrawalMessage(withdrawal!), signature: body.signature as Hex }))
      .catch(() => false);
    if (!validSignature) throw new AuthError("WITHDRAWAL_SIGNATURE_INVALID", 403);
    const existing = await context.env.DB.prepare(
      `SELECT wi.id, wi.status FROM usdc_withdrawal_intents uwi
       JOIN wallet_intents wi ON wi.id = uwi.intent_id WHERE uwi.nonce = ?1`,
    ).bind(body.nonce).first<{ id: string; status: string }>();
    if (existing) return context.json({ intentId: existing.id, status: existing.status, existing: true });

    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as ApprovalRouteClient & {
        getBalance(input: { address: Address }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      };
    if (tokenWithdrawal) {
      const held = await client.readContract({ address: tokenWithdrawal.token, abi: swapTokenAbi,
        functionName: "balanceOf", args: [wallet.address] }).catch(() => null);
      if (typeof held !== "bigint") return context.json({ error: "TOKEN_READ_FAILED" }, 502);
      if (held < tokenWithdrawal.amount) return context.json({ error: "INSUFFICIENT_TOKEN_BALANCE" }, 422);
    }
    const [balance, gas, fees] = await Promise.all([
      client.getBalance({ address: transfer.wallet }),
      client.estimateGas({ account: transfer.wallet, to: transfer.to,
        data: transfer.data, value: 0n }),
      client.estimateFeesPerGas(),
    ]);
    const feeReserve = (gas * 120n * fees.maxFeePerGas + 99n) / 100n;
    // The network fee is paid in USDC either way; a USDC withdrawal must leave enough for it.
    if (!canSpendArcUsdc(balance, withdrawal?.amount ?? 0n, feeReserve)) {
      return context.json({ error: "INSUFFICIENT_USDC_AFTER_FEES" }, 422);
    }
    const intentId = `withdrawal_${crypto.randomUUID()}`;
    const payloadHash = tokenWithdrawal
      ? tokenWithdrawalPayloadHash(tokenWithdrawal, body.signature as Hex)
      : withdrawalPayloadHash(withdrawal!, body.signature as Hex);
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents
         (id, wallet_id, kind, payload_hash, status, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)`,
      ).bind(intentId, wallet.id, tokenWithdrawal ? "token_withdrawal" : "usdc_withdrawal", payloadHash,
        body.expiresAt * 1_000, timestamp),
      context.env.DB.prepare(
        `INSERT INTO usdc_withdrawal_intents
         (intent_id, chain_id, recipient, amount, owner_address, owner_signature,
          nonce, signature_expires_at, calldata, created_at, token_address)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(intentId, ARC_CHAIN_ID, transfer.recipient, transfer.amount.toString(),
        wallet.owner_address, body.signature, transfer.nonce, body.expiresAt,
        transfer.data, timestamp, tokenWithdrawal?.token ?? null),
    ]);
    return context.json({ intentId, status: "pending", gasEstimate: gas.toString(),
      feeReserve: feeReserve.toString() }, 201);
  });

  app.post("/v1/wallets/withdrawals/maximum", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.recipient !== "string" || !isAddress(body.recipient)) {
      throw new AuthError("INVALID_WITHDRAWAL_RECIPIENT", 400);
    }
    const recipient = getAddress(body.recipient);
    const wallet = await context.env.DB.prepare(
      "SELECT address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ address: Address; state: string }>();
    if (!wallet) throw new AuthError("WALLET_NOT_FOUND", 404);
    if (wallet.state !== "active" && wallet.state !== "paused") {
      throw new AuthError("WALLET_NOT_ACTIONABLE", 409);
    }
    if (recipient === wallet.address || recipient === zeroAddress) {
      throw new AuthError("INVALID_WITHDRAWAL_RECIPIENT", 400);
    }
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as ApprovalRouteClient & {
        getBalance(input: { address: Address }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      };
    const probe = buildUsdcWithdrawal({ wallet: wallet.address, recipient,
      amount: 1n, nonce: `0x${"0".repeat(64)}`, expiresAt: BigInt(Math.floor(now() / 1_000) + 300) });
    const balance = await client.getBalance({ address: wallet.address });
    if (balance < 1_000_000_000_000n) {
      return context.json({ maximum: "0", feeReserve: "0" });
    }
    const [gas, fees] = await Promise.all([
      client.estimateGas({ account: wallet.address, to: probe.to, data: probe.data, value: 0n }),
      client.estimateFeesPerGas(),
    ]);
    // More headroom than prepare's 120% check: the real transfer's gas and the base fee can
    // come out slightly higher by the time the owner has signed.
    const feeReserve = (gas * 150n * fees.maxFeePerGas + 99n) / 100n;
    const maximum = maxArcUsdcAmount(balance, feeReserve);
    return context.json({ maximum: maximum.toString(), feeReserve: feeReserve.toString() });
  });

  app.get("/v1/wallets/v4/pools/:poolId/allowances", async (context) => {
    const poolId = context.req.param("poolId");
    if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new AuthError("INVALID_POOL_ID", 400);
    const row = await context.env.DB.prepare("SELECT * FROM v4_pool_directory WHERE pool_id = ?1")
      .bind(poolId).first<V4PoolDirectoryRow>();
    if (!row) return context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);
    const spender = context.req.query("purpose") === "swap"
      ? UNISWAP_SHARED_ARC.universalRouter.address : UNISWAP_V4_ARC.positionManager;
    const wallet = await context.env.DB.prepare(
      "SELECT address FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as ChainReadClient;
    const tokens = [row.currency0, row.currency1].filter((address) => address !== zeroAddress);
    const allowances = await Promise.all(tokens.map(async (token) => {
      const read = await readArcV4Allowances({ client, owner: wallet.address, token: getAddress(token), spender });
      const balance = await client.readContract({ address: getAddress(token), abi: swapTokenAbi,
        functionName: "balanceOf", args: [wallet.address] });
      return { token, balance: String(balance), erc20: read.erc20.toString(),
        permit2: read.permit2.toString(), expiration: read.expiration.toString() };
    }));
    const nativeBalance = await client.getBalance({ address: wallet.address });
    return context.json({ allowances, nativeBalance: nativeBalance.toString() });
  });

  async function loadV4Swap(context: Context<AppEnvironment>, body: Record<string, unknown>) {
    if (typeof body.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.poolId) ||
        typeof body.tokenIn !== "string" || !isAddress(body.tokenIn) ||
        typeof body.amountIn !== "string" || !/^[1-9][0-9]*$/.test(body.amountIn)) {
      throw new AuthError("INVALID_V4_SWAP_REQUEST", 400);
    }
    const row = await context.env.DB.prepare("SELECT * FROM v4_pool_directory WHERE pool_id = ?1")
      .bind(body.poolId).first<V4PoolDirectoryRow>();
    if (!row) throw new AuthError("POOL_NOT_ELIGIBLE", 404);
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) throw new AuthError("WALLET_NOT_FOUND", 404);
    if (wallet.state !== "active") throw new AuthError("WALLET_NOT_ACTIVE", 409);
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as unknown as
      ApprovalRouteClient & {
        call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<unknown>;
        estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) throw new AuthError("ARC_SAFE_BLOCK_UNAVAILABLE", 503);
    const pool = await readArcV4Pool({ client, key: {
      currency0: getAddress(row.currency0), currency1: getAddress(row.currency1),
      fee: row.fee, tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks),
    }, blockNumber: safe.number });
    if (!pool || pool.id.toLowerCase() !== row.pool_id.toLowerCase() || BigInt(pool.liquidity) <= 0n) {
      throw new AuthError("POOL_NOT_AVAILABLE", 422);
    }
    const tokenIn = getAddress(body.tokenIn);
    if (tokenIn !== pool.currency0 && tokenIn !== pool.currency1) throw new AuthError("TOKEN_NOT_IN_POOL", 400);
    const amountIn = BigInt(body.amountIn);
    let quoted;
    try {
      quoted = await quoteArcV4Swap({ client, pool, account: wallet.address,
        tokenIn, amountIn, blockNumber: safe.number });
    } catch {
      throw new AuthError("V4_POOL_NOT_EXECUTABLE", 422);
    }
    // An almost empty pool fills a trade at a ruinous price: refuse before anything is prepared.
    const impactBps = priceImpactBps({ sqrtPriceX96: pool.sqrtPriceX96, zeroForOne: tokenIn === pool.currency0,
      amountIn, amountOut: quoted.amountOut, feePips: pool.lpFee });
    if (impactBps > MAX_PRICE_IMPACT_BPS) throw new AuthError("PRICE_IMPACT_TOO_HIGH", 422);
    const tokenOut = tokenIn === pool.currency0 ? pool.currency1 : pool.currency0;
    const [nativeBalance, tokenBalance, allowance] = await Promise.all([
      client.getBalance({ address: wallet.address, blockNumber: safe.number }),
      tokenIn === zeroAddress ? Promise.resolve(0n) : client.readContract({ address: tokenIn,
        abi: swapTokenAbi, functionName: "balanceOf", args: [wallet.address], blockNumber: safe.number }),
      tokenIn === zeroAddress ? Promise.resolve(null) : readArcV4Allowances({ client,
        owner: wallet.address, token: tokenIn,
        spender: UNISWAP_SHARED_ARC.universalRouter.address, blockNumber: safe.number }),
    ]);
    if (tokenIn !== zeroAddress && (typeof tokenBalance !== "bigint" || tokenBalance < amountIn)) {
      throw new AuthError("INSUFFICIENT_TOKEN_BALANCE", 422);
    }
    return { wallet, client, safe, pool, tokenIn, tokenOut, amountIn, quoted,
      nativeBalance, allowance, impactBps };
  }

  app.post("/v1/wallets/v4/swaps/quote", async (context) => {
    const body = record(await jsonBody(context));
    const slippageBps = body.slippageBps === undefined ? 100 : body.slippageBps;
    if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) ||
        slippageBps < 0 || slippageBps > 500) throw new AuthError("INVALID_SLIPPAGE", 400);
    const swap = await loadV4Swap(context, body);
    const minimumAmountOut = swap.quoted.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
    if (minimumAmountOut <= 0n) throw new AuthError("V4_QUOTE_TOO_SMALL", 422);
    return context.json({ poolId: swap.pool.id, tokenIn: swap.tokenIn, tokenOut: swap.tokenOut,
      amountIn: swap.amountIn.toString(), expectedAmountOut: swap.quoted.amountOut.toString(),
      minimumAmountOut: minimumAmountOut.toString(),
      nativeBalance: swap.nativeBalance.toString(),
      priceImpactBps: swap.impactBps,
      allowance: swap.allowance ? { erc20: swap.allowance.erc20.toString(),
        permit2: swap.allowance.permit2.toString(), expiration: swap.allowance.expiration.toString() } : null,
      blockNumber: swap.safe.number!.toString() });
  });

  app.post("/v1/wallets/v4/swaps/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.slippageBps !== "number" || !Number.isInteger(body.slippageBps) ||
        body.slippageBps < 0 || body.slippageBps > 500 ||
        typeof body.minimumAmountOut !== "string" || !/^[1-9][0-9]*$/.test(body.minimumAmountOut) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) throw new AuthError("INVALID_V4_SWAP_REQUEST", 400);
    const swap = await loadV4Swap(context, body);
    const minimumAmountOut = BigInt(body.minimumAmountOut);
    const freshFloor = swap.quoted.amountOut * BigInt(10_000 - body.slippageBps) / 10_000n;
    if (minimumAmountOut < freshFloor || minimumAmountOut > swap.quoted.amountOut) {
      throw new AuthError("V4_QUOTE_STALE", 422);
    }
    const deadline = BigInt(Math.floor(now() / 1_000) + 10 * 60);
    if (swap.allowance && (swap.allowance.erc20 < swap.amountIn ||
        swap.allowance.permit2 < swap.amountIn || swap.allowance.expiration <= deadline)) {
      throw new AuthError("V4_APPROVAL_REQUIRED", 422);
    }
    let built;
    try {
      built = buildArcV4Swap({ pool: swap.pool, tokenIn: swap.tokenIn,
        amountIn: swap.amountIn, amountOutMinimum: minimumAmountOut,
        deadline });
    } catch {
      throw new AuthError("INVALID_V4_SWAP_LIMITS", 422);
    }
    let gas: bigint;
    try {
      await swap.client.call({ account: swap.wallet.address, to: built.to, data: built.data,
        value: built.value, blockNumber: swap.safe.number! });
      gas = await swap.client.estimateGas({ account: swap.wallet.address, to: built.to,
        data: built.data, value: built.value, blockNumber: swap.safe.number! });
    } catch (error) {
      console.warn("V4 swap simulation failed", { poolId: swap.pool.id, error });
      throw new AuthError("V4_SWAP_SIMULATION_FAILED", 422);
    }
    const fees = await swap.client.estimateFeesPerGas();
    const feeReserve = (gas * 120n * fees.maxFeePerGas + 99n) / 100n;
    if (swap.nativeBalance < built.value + feeReserve ||
        (swap.tokenIn === ARC_TOKENS.USDC.address &&
          !canSpendArcUsdc(swap.nativeBalance, swap.amountIn, feeReserve))) {
      throw new AuthError("INSUFFICIENT_USDC_AFTER_FEES", 422);
    }
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    const existing = await context.env.DB.prepare(
      `SELECT id, status FROM wallet_intents WHERE wallet_id = ?1 AND kind = 'v4_single_pool_swap'
       AND idempotency_key_hash = ?2`,
    ).bind(swap.wallet.id, idempotencyKeyHash).first<{ id: string; status: string }>();
    if (existing) return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    const intentId = `v4_swap_${crypto.randomUUID()}`;
    const timestamp = now();
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
          created_at, updated_at, idempotency_key_hash, automation_run_id)
         VALUES (?1, ?2, 'v4_single_pool_swap', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
      ).bind(intentId, swap.wallet.id, arcV4SwapPayloadHash(built), Number(deadline) * 1_000,
        timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
        `INSERT INTO v4_swap_intents (intent_id, pool_id, currency0, currency1, fee,
          tick_spacing, hooks, token_in, amount_in, amount_out_minimum, deadline,
          calldata, native_value, simulation_block, simulation_block_hash, gas_estimate, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      ).bind(intentId, swap.pool.id, swap.pool.currency0, swap.pool.currency1, swap.pool.fee,
        swap.pool.tickSpacing, swap.pool.hooks, built.tokenIn, built.amountIn.toString(),
        built.amountOutMinimum.toString(), built.deadline.toString(), built.data,
        built.value.toString(), Number(swap.safe.number), swap.safe.hash, gas.toString(), timestamp),
    ]);
    return context.json({ intentId, status: "pending", expectedAmountOut: swap.quoted.amountOut.toString(),
      minimumAmountOut: built.amountOutMinimum.toString(), gasEstimate: gas.toString() }, 201);
  });

  app.post("/v1/wallets/v4/approvals/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if (typeof body.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.poolId) ||
        typeof body.token !== "string" || !isAddress(body.token) ||
        (body.stage !== "erc20" && body.stage !== "permit2") ||
        (body.purpose !== undefined && body.purpose !== "mint" && body.purpose !== "swap") ||
        typeof body.amount !== "string" || !/^[1-9][0-9]*$/.test(body.amount) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) throw new AuthError("INVALID_V4_APPROVAL_REQUEST", 400);
    const row = await context.env.DB.prepare("SELECT * FROM v4_pool_directory WHERE pool_id = ?1")
      .bind(body.poolId).first<V4PoolDirectoryRow>();
    if (!row) return context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);
    const token = getAddress(body.token);
    if (token === zeroAddress || (token !== getAddress(row.currency0) && token !== getAddress(row.currency1))) {
      throw new AuthError("TOKEN_NOT_IN_POOL", 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as unknown as
      ApprovalRouteClient & {
        call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<unknown>;
        estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<bigint>;
      };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) throw new AuthError("ARC_SAFE_BLOCK_UNAVAILABLE", 503);
    const pool = await readArcV4Pool({ client, key: { currency0: getAddress(row.currency0),
      currency1: getAddress(row.currency1), fee: row.fee, tickSpacing: row.tick_spacing,
      hooks: getAddress(row.hooks) }, blockNumber: safe.number });
    if (!pool || pool.id.toLowerCase() !== row.pool_id.toLowerCase() || BigInt(pool.liquidity) <= 0n) {
      throw new AuthError("POOL_NOT_AVAILABLE", 422);
    }
    const amount = BigInt(body.amount as string);
    const spender = body.purpose === "swap"
      ? UNISWAP_SHARED_ARC.universalRouter.address : UNISWAP_V4_ARC.positionManager;
    const expiration = body.stage === "permit2"
      ? BigInt(Math.floor(now() / 1_000) + PERMIT2_APPROVAL_SECONDS) : 0n;
    let approval;
    try {
      approval = buildArcV4Approval({ poolId: pool.id, token, stage: body.stage,
        amount, expiration, spender });
      await client.call({ account: wallet.address, to: approval.to, data: approval.data,
        value: 0n, blockNumber: safe.number });
    } catch {
      throw new AuthError("V4_APPROVAL_SIMULATION_FAILED", 422);
    }
    const gas = await client.estimateGas({ account: wallet.address, to: approval.to,
      data: approval.data, value: 0n, blockNumber: safe.number });
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    const existing = await context.env.DB.prepare(
      `SELECT id, status FROM wallet_intents WHERE wallet_id = ?1 AND kind = 'v4_approval'
       AND idempotency_key_hash = ?2`,
    ).bind(wallet.id, idempotencyKeyHash).first<{ id: string; status: string }>();
    if (existing) return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    const timestamp = now();
    const intentId = `v4_approval_${crypto.randomUUID()}`;
    await context.env.DB.batch([context.env.DB.prepare(
      `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
        created_at, updated_at, idempotency_key_hash, automation_run_id)
       VALUES (?1, ?2, 'v4_approval', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
    ).bind(intentId, wallet.id, arcV4ApprovalPayloadHash(approval), timestamp + 10 * 60 * 1_000,
      timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null), context.env.DB.prepare(
      `INSERT INTO v4_approval_intents (intent_id, pool_id, currency0, currency1,
        fee, tick_spacing, hooks, token, token_decimals, stage, spender, amount, expiration,
        target, calldata, simulation_block, simulation_block_hash, gas_estimate, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
    ).bind(intentId, pool.id, pool.currency0, pool.currency1, pool.fee, pool.tickSpacing,
      pool.hooks, token, token === ARC_TOKENS.USDC.address ? 6 : row.token_decimals,
      approval.stage, approval.spender, amount.toString(), expiration.toString(), approval.to, approval.data,
      Number(safe.number), safe.hash, gas.toString(), timestamp)]);
    return context.json({ intentId, status: "pending", transaction: {
      chainId: ARC_CHAIN_ID, to: approval.to, data: approval.data, value: "0" },
      simulation: { blockNumber: safe.number.toString(), blockHash: safe.hash,
        gasEstimate: gas.toString() } }, 201);
  });

  app.post("/v1/wallets/approvals/prepare", async (context) => {
    const body = record(await jsonBody(context));
    let suppliedTokenAddress: Address;
    let suppliedPoolAddress: Address;
    let suppliedPoolTokenAddress: Address;
    const approvalSpender = body.spender === "swap"
      ? UNISWAP_SWAP_ARC.swapRouter02 : UNISWAP_V3_ARC.nonfungiblePositionManager.address;
    // Every approval is for a pool: the token being approved, and the pool's token.
    if (typeof body.tokenAddress !== "string" || typeof body.poolAddress !== "string") {
      throw new AuthError("TOKEN_NOT_ALLOWED", 400);
    }
    try {
      suppliedTokenAddress = getAddress(body.tokenAddress);
      suppliedPoolAddress = getAddress(body.poolAddress);
      suppliedPoolTokenAddress = getAddress(
        suppliedTokenAddress === ARC_TOKENS.USDC.address
          ? body.poolTokenAddress as string : body.tokenAddress,
      );
    } catch {
      throw new AuthError("INVALID_TOKEN_ADDRESS", 400);
    }
    if (
      typeof body.amount !== "string" ||
      !/^[1-9][0-9]*$/.test(body.amount)
    ) {
      throw new AuthError("INVALID_APPROVAL_AMOUNT", 400);
    }
    if (
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.length < 16 ||
      body.idempotencyKey.length > 200
    ) {
      throw new AuthError("INVALID_IDEMPOTENCY_KEY", 400);
    }

    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    )
      .bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") {
      return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    }

    let approvedToken: Awaited<ReturnType<typeof discoverArcTokenPools>>["token"];
    const discoveryClient = (
      dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })
    ) as unknown as PoolDiscoveryClient;
    try {
      const discovery = await discoverArcTokenPools({
        client: discoveryClient,
        tokenAddress: suppliedPoolTokenAddress,
        owner: wallet.address,
      });
      const selected = discovery.pools.find((pool) => pool.address === suppliedPoolAddress);
      if (!selected) throw new AuthError("POOL_NOT_ALLOWED", 422);
      approvedToken = suppliedTokenAddress === ARC_TOKENS.USDC.address ? discovery.usdc : discovery.token;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("POOL_DISCOVERY_FAILED", 422);
    }

    let approval;
    try {
      approval = buildApproval({
        tokenAddress: suppliedTokenAddress,
        tokenSymbol: approvedToken.symbol,
        amount: BigInt(body.amount as string),
        spender: approvalSpender,
      });
    } catch {
      throw new AuthError("INVALID_APPROVAL_AMOUNT", 400);
    }
    const approvalToken = approvedToken.symbol;

    const timestamp = now();
    const intentId = `approval_${crypto.randomUUID()}`;
    const kind = "erc20_approval";
    const payloadHash = approvalPayloadHash(approval);
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO wallet_intents (
        id, wallet_id, kind, payload_hash, status, expires_at, created_at,
        updated_at, idempotency_key_hash, automation_run_id
      ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
    )
      .bind(
        intentId,
        wallet.id,
        kind,
        payloadHash,
        timestamp + 10 * 60 * 1_000,
        timestamp,
        idempotencyKeyHash,
        context.get("agentRun")?.id ?? null,
      )
      .run();

    const stored = await context.env.DB.prepare(
      `SELECT wallet_intents.id, wallet_intents.payload_hash,
              wallet_intents.status, approval_intents.simulation_block,
              approval_intents.simulation_block_hash, approval_intents.gas_estimate
       FROM wallet_intents
       LEFT JOIN approval_intents ON approval_intents.intent_id = wallet_intents.id
       WHERE wallet_intents.wallet_id = ?1 AND wallet_intents.kind = ?2
         AND wallet_intents.idempotency_key_hash = ?3`,
    )
      .bind(wallet.id, kind, idempotencyKeyHash)
      .first<{
        id: string;
        payload_hash: string;
        status: string;
        simulation_block: number | null;
        simulation_block_hash: Hex | null;
        gas_estimate: string | null;
      }>();
    if (!stored) throw new Error("Approval intent insert was not persisted");
    if (stored.payload_hash !== payloadHash) {
      return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
    }
    if (stored.id !== intentId) {
      return context.json({
        intentId: stored.id,
        status: stored.status,
        transaction: {
          chainId: approval.chainId,
          to: approval.to,
          data: approval.data,
          value: "0",
        },
        simulation: stored.simulation_block === null
          ? null
          : {
              blockNumber: String(stored.simulation_block),
              blockHash: stored.simulation_block_hash,
              gasEstimate: stored.gas_estimate,
            },
      });
    }

    await context.env.DB.prepare(
      `INSERT INTO approval_intents (
        intent_id, chain_id, token_symbol, token_address, token_decimals,
        pool_address, pool_token_address, spender, amount, calldata, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(
        intentId,
        ARC_CHAIN_ID,
        approvalToken,
        approval.tokenAddress,
        approvedToken.decimals,
        suppliedPoolAddress,
        suppliedPoolTokenAddress,
        approval.spender,
        approval.amount.toString(),
        approval.data,
        timestamp,
      )
      .run();

    const client =
      dependencies.createChainClient?.(context.env) ??
      (createPublicClient({
        chain: arc,
        transport: http(context.env.ARC_RPC_URL),
        batch: { multicall: true },
      }) as unknown as ApprovalRouteClient);
    try {
      const block = await (client as ApprovalRouteClient).getBlock({
        blockTag: "safe",
      });
      if (block.number === null || block.hash === null) {
        throw new Error("Arc safe block unavailable");
      }
      const simulation = await simulateApproval({
        client: client as ApprovalRouteClient,
        owner: wallet.address,
        approval,
        blockNumber: block.number,
      });
      await context.env.DB.prepare(
        `UPDATE approval_intents SET simulation_block = ?2,
          simulation_block_hash = ?3, gas_estimate = ?4 WHERE intent_id = ?1`,
      )
        .bind(
          intentId,
          Number(block.number),
          block.hash,
          simulation.gasEstimate,
        )
        .run();
      return context.json({
        intentId,
        status: "pending",
        token: approvalToken,
        tokenAddress: approval.tokenAddress,
        poolAddress: suppliedPoolAddress,
        spender: approval.spender,
        amount: approval.amount.toString(),
        transaction: {
          chainId: approval.chainId,
          to: approval.to,
          data: approval.data,
          value: "0",
        },
        simulation: { ...simulation, blockHash: block.hash },
      }, 201);
    } catch {
      console.warn("Approval simulation rejected", intentId);
      await context.env.DB.prepare(
        `UPDATE wallet_intents SET status = 'rejected',
          failure_reason = 'APPROVAL_SIMULATION_FAILED', updated_at = ?2
         WHERE id = ?1 AND status = 'pending'`,
      )
        .bind(intentId, now())
        .run();
      return context.json({ error: "APPROVAL_SIMULATION_FAILED", intentId }, 422);
    }
  });

  app.get("/v1/wallets/v4/positions", async (context) => {
    const wallet = await context.env.DB.prepare(
      "SELECT id, address FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    const page = Number(context.req.query("page") ?? "0");
    if (!Number.isSafeInteger(page) || page < 0 || page > 1000) {
      return context.json({ error: "INVALID_PAGE" }, 400);
    }
    try {
      return context.json({ ...await mintedV4Positions(context.env, wallet, page * 50), page });
    } catch {
      return context.json({ error: "V4_POSITIONS_UNAVAILABLE" }, 503);
    }
  });

  app.post("/v1/wallets/v4/positions/mint/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const positive = (value: unknown) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
    if (typeof body.poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.poolId) ||
        !positive(body.amount0Desired) || !positive(body.amount1Desired) ||
        typeof body.tickLower !== "number" || typeof body.tickUpper !== "number" ||
        typeof body.slippageBps !== "number" || !positive(body.deadline) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) throw new AuthError("INVALID_V4_MINT_REQUEST", 400);
    const deadline = BigInt(body.deadline as string);
    const nowSeconds = BigInt(Math.floor(now() / 1_000));
    if (deadline < nowSeconds + 60n || deadline > nowSeconds + 30n * 60n) {
      throw new AuthError("INVALID_MINT_DEADLINE", 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    const row = await context.env.DB.prepare(
      "SELECT * FROM v4_pool_directory WHERE pool_id = ?1",
    ).bind(body.poolId).first<V4PoolDirectoryRow>();
    if (!row) return context.json({ error: "POOL_NOT_ELIGIBLE" }, 404);

    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as unknown as
      ApprovalRouteClient & {
        call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<unknown>;
        estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) throw new AuthError("ARC_SAFE_BLOCK_UNAVAILABLE", 503);
    const key = { currency0: getAddress(row.currency0), currency1: getAddress(row.currency1),
      fee: row.fee, tickSpacing: row.tick_spacing, hooks: getAddress(row.hooks) };
    const pool = await readArcV4Pool({ client, key, blockNumber: safe.number });
    if (!pool || pool.id.toLowerCase() !== row.pool_id.toLowerCase() || BigInt(pool.liquidity) <= 0n) {
      throw new AuthError("POOL_NOT_AVAILABLE", 422);
    }
    // An almost empty pool's price can be pushed anywhere for pennies; a new band there gets arbitraged.
    if (poolDepthUsd(pool) < MIN_POOL_DEPTH_USD) throw new AuthError("POOL_TOO_THIN", 422);
    let mint;
    try {
      mint = buildArcV4Mint({ pool, tokenDecimals: row.token_decimals, recipient: wallet.address,
        tickLower: body.tickLower, tickUpper: body.tickUpper,
        amount0Desired: BigInt(body.amount0Desired as string),
        amount1Desired: BigInt(body.amount1Desired as string),
        slippageBps: body.slippageBps, deadline });
    } catch {
      throw new AuthError("INVALID_V4_MINT_REQUEST", 400);
    }
    const required = [
      { token: pool.currency0, amount: mint.amount0Max },
      { token: pool.currency1, amount: mint.amount1Max },
    ].filter((entry) => entry.token !== zeroAddress && entry.amount > 0n);
    for (const entry of required) {
      const allowance = await readArcV4Allowances({ client, owner: wallet.address,
        token: entry.token, blockNumber: safe.number });
      if (allowance.erc20 < entry.amount || allowance.permit2 < entry.amount ||
          allowance.expiration <= deadline) {
        throw new AuthError("V4_APPROVAL_REQUIRED", 422);
      }
    }
    try {
      await client.call({ account: wallet.address, to: mint.to, data: mint.data,
        value: mint.value, blockNumber: safe.number });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("V4_MINT_SIMULATION_FAILED", 422);
    }
    const usdcMax = row.token_address.toLowerCase() === pool.currency0.toLowerCase()
      ? mint.amount1Max : mint.amount0Max;
    const [gas, fees, nativeBalance] = await Promise.all([
      client.estimateGas({ account: wallet.address, to: mint.to, data: mint.data, value: mint.value,
        blockNumber: safe.number }),
      client.estimateFeesPerGas(),
      client.getBalance({ address: wallet.address, blockNumber: safe.number }),
    ]);
    const feeReserve = (gas * 120n * fees.maxFeePerGas + 99n) / 100n;
    if (nativeBalance < mint.value + feeReserve ||
        (mint.value === 0n && !canSpendArcUsdc(nativeBalance, usdcMax, feeReserve))) {
      throw new AuthError("INSUFFICIENT_USDC_AFTER_FEES", 422);
    }
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    const existing = await context.env.DB.prepare(
      `SELECT id, status FROM wallet_intents WHERE wallet_id = ?1 AND kind = 'v4_position_mint'
       AND idempotency_key_hash = ?2`,
    ).bind(wallet.id, idempotencyKeyHash).first<{ id: string; status: string }>();
    if (existing) return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    const intentId = `v4_mint_${crypto.randomUUID()}`;
    const timestamp = now();
    await context.env.DB.batch([context.env.DB.prepare(
      `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
        created_at, updated_at, idempotency_key_hash, automation_run_id)
       VALUES (?1, ?2, 'v4_position_mint', ?3, 'pending', ?4, ?5, ?5, ?6, ?7)`,
    ).bind(intentId, wallet.id, arcV4MintPayloadHash(mint), Number(deadline) * 1_000,
      timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null), context.env.DB.prepare(
      `INSERT INTO v4_mint_intents (intent_id, pool_id, currency0, currency1, fee,
        tick_spacing, hooks, token_decimals, sqrt_price_x96, tick, liquidity, lp_fee,
        recipient, tick_lower, tick_upper, amount0_desired, amount1_desired,
        amount0_max, amount1_max, slippage_bps, deadline, calldata, native_value,
        simulation_block, simulation_block_hash, gas_estimate, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)`,
    ).bind(intentId, pool.id, pool.currency0, pool.currency1, pool.fee, pool.tickSpacing,
      pool.hooks, row.token_decimals, pool.sqrtPriceX96, pool.tick, pool.liquidity,
      pool.lpFee, wallet.address, mint.tickLower, mint.tickUpper,
      String(body.amount0Desired), String(body.amount1Desired), mint.amount0Max.toString(),
      mint.amount1Max.toString(), body.slippageBps, deadline.toString(), mint.data,
      mint.value.toString(), Number(safe.number), safe.hash, gas.toString(), timestamp)]);
    return context.json({ intentId, status: "pending", transaction: {
      chainId: ARC_CHAIN_ID, to: UNISWAP_V4_ARC.positionManager, data: mint.data,
      value: mint.value.toString() }, simulation: { blockNumber: safe.number.toString(),
      blockHash: safe.hash, gasEstimate: gas.toString() } }, 201);
  });

  app.post("/v1/wallets/v4/positions/actions/prepare", async (context) => {
    const body = record(await jsonBody(context));
    if ((body.action !== "collect" && body.action !== "withdraw") ||
        typeof body.tokenId !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.tokenId) ||
        typeof body.slippageBps !== "number" || !Number.isInteger(body.slippageBps) ||
        body.slippageBps < 0 || body.slippageBps > 500 ||
        typeof body.deadline !== "string" || !/^[1-9][0-9]*$/.test(body.deadline) ||
        typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
        body.idempotencyKey.length > 200) throw new AuthError("INVALID_V4_ACTION_REQUEST", 400);
    const deadline = BigInt(body.deadline);
    const nowSeconds = BigInt(Math.floor(now() / 1_000));
    if (deadline < nowSeconds + 60n || deadline > nowSeconds + 30n * 60n) {
      throw new AuthError("INVALID_ACTION_DEADLINE", 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id).first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active" && wallet.state !== "paused") {
      return context.json({ error: "WALLET_NOT_SIGNABLE" }, 409);
    }
    const client = (dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })) as unknown as
      ApprovalRouteClient & {
        call(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<unknown>;
        estimateGas(input: { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint }): Promise<bigint>;
        estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
      };
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null || safe.hash === null) throw new AuthError("ARC_SAFE_BLOCK_UNAVAILABLE", 503);
    const tokenId = BigInt(body.tokenId);
    let position;
    try {
      position = await readArcV4Position({ client, tokenId, owner: wallet.address,
        blockNumber: safe.number });
    } catch { throw new AuthError("V4_POSITION_NOT_OWNED", 404); }
    const row = await context.env.DB.prepare("SELECT * FROM v4_pool_directory WHERE pool_id = ?1")
      .bind(position.poolId).first<V4PoolDirectoryRow>();
    if (!row || position.liquidity <= 0n) throw new AuthError("V4_POSITION_NOT_ELIGIBLE", 422);
    const pool = await readArcV4Pool({ client, key: position.poolKey,
      blockNumber: safe.number });
    if (!pool || pool.id.toLowerCase() !== row.pool_id.toLowerCase()) {
      throw new AuthError("POOL_NOT_AVAILABLE", 422);
    }
    let action;
    try {
      action = buildArcV4PositionAction({ kind: body.action, pool,
        tokenDecimals: row.token_decimals, tokenId, recipient: wallet.address,
        liquidity: position.liquidity, tickLower: position.tickLower,
        tickUpper: position.tickUpper, slippageBps: body.slippageBps, deadline });
      await client.call({ account: wallet.address, to: action.to,
        data: action.data, value: 0n, blockNumber: safe.number });
    } catch { throw new AuthError("V4_ACTION_SIMULATION_FAILED", 422); }
    const [gas, fees, nativeBalance] = await Promise.all([
      client.estimateGas({ account: wallet.address, to: action.to, data: action.data,
        value: 0n, blockNumber: safe.number }), client.estimateFeesPerGas(),
      client.getBalance({ address: wallet.address, blockNumber: safe.number }),
    ]);
    if (nativeBalance < (gas * 120n * fees.maxFeePerGas + 99n) / 100n) {
      throw new AuthError("INSUFFICIENT_USDC_AFTER_FEES", 422);
    }
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    const kind = body.action === "collect" ? "v4_position_collect" : "v4_position_withdraw";
    const existing = await context.env.DB.prepare(
      "SELECT id, status FROM wallet_intents WHERE wallet_id = ?1 AND kind = ?2 AND idempotency_key_hash = ?3",
    ).bind(wallet.id, kind, idempotencyKeyHash).first<{ id: string; status: string }>();
    if (existing) return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    const intentId = `v4_action_${crypto.randomUUID()}`;
    const timestamp = now();
    await context.env.DB.batch([context.env.DB.prepare(
      `INSERT INTO wallet_intents (id, wallet_id, kind, payload_hash, status, expires_at,
        created_at, updated_at, idempotency_key_hash, automation_run_id)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
    ).bind(intentId, wallet.id, kind, arcV4PositionActionPayloadHash(action),
      Number(deadline) * 1000, timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null),
      context.env.DB.prepare(
      `INSERT INTO v4_position_action_intents (intent_id, action, pool_id, token_id,
        tick_lower, tick_upper, liquidity, token_decimals, slippage_bps, deadline,
        recipient, calldata, simulation_block, simulation_block_hash, gas_estimate, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(intentId, action.kind, action.poolId, tokenId.toString(),
      position.tickLower, position.tickUpper, position.liquidity.toString(),
      row.token_decimals, action.slippageBps, deadline.toString(),
      wallet.address, action.data, Number(safe.number), safe.hash, gas.toString(), timestamp)]);
    return context.json({ intentId, status: "pending", simulation: {
      blockNumber: safe.number.toString(), blockHash: safe.hash,
      gasEstimate: gas.toString() } }, 201);
  });

  app.post("/v1/wallets/positions/mint/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const integerString = (value: unknown) =>
      typeof value === "string" && /^[1-9][0-9]*$/.test(value);
    if (
      !integerString(body.amountToken) ||
      !integerString(body.amountUsdc) ||
      typeof body.tokenAddress !== "string" || typeof body.poolAddress !== "string" ||
      typeof body.tickLower !== "number" ||
      typeof body.tickUpper !== "number" ||
      typeof body.slippageBps !== "number" ||
      !integerString(body.deadline) ||
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.length < 16 ||
      body.idempotencyKey.length > 200
    ) {
      throw new AuthError("INVALID_MINT_REQUEST", 400);
    }
    let requestedTokenAddress: Address;
    let requestedPoolAddress: Address;
    try {
      requestedTokenAddress = getAddress(body.tokenAddress);
      requestedPoolAddress = getAddress(body.poolAddress);
    } catch {
      throw new AuthError("INVALID_TOKEN_ADDRESS", 400);
    }
    if (requestedTokenAddress === ARC_TOKENS.USDC.address) {
      throw new AuthError("TOKEN_NOT_ALLOWED", 400);
    }
    const deadline = BigInt(body.deadline as string);
    const nowSeconds = BigInt(Math.floor(now() / 1_000));
    if (deadline < nowSeconds + 60n || deadline > nowSeconds + 30n * 60n) {
      throw new AuthError("INVALID_MINT_DEADLINE", 400);
    }
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    )
      .bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (wallet.state !== "active") {
      return context.json({ error: "WALLET_NOT_ACTIVE" }, 409);
    }

    let selectedPool: Awaited<ReturnType<typeof discoverArcTokenPools>>["pools"][number];
    let discoveredToken: Awaited<ReturnType<typeof discoverArcTokenPools>>["token"];
    const discoveryClient = (
      dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })
    ) as unknown as PoolDiscoveryClient;
    try {
      const discovery = await discoverArcTokenPools({
        client: discoveryClient,
        tokenAddress: requestedTokenAddress,
        owner: wallet.address,
      });
      const found = discovery.pools.find((pool) => pool.address === requestedPoolAddress);
      if (!found) throw new AuthError("POOL_NOT_ALLOWED", 422);
      // An almost empty pool's price can be pushed anywhere for pennies; a new band there gets arbitraged.
      if (poolDepthUsd({ currency0: found.token0.address, currency1: found.token1.address,
        sqrtPriceX96: found.sqrtPriceX96, liquidity: found.liquidity }) < MIN_POOL_DEPTH_USD) {
        throw new AuthError("POOL_TOO_THIN", 422);
      }
      selectedPool = found;
      discoveredToken = discovery.token;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("POOL_DISCOVERY_FAILED", 422);
    }

    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    const kind = "position_mint";
    const existing = await context.env.DB.prepare(
      `SELECT id, payload_hash, status FROM wallet_intents
       WHERE wallet_id = ?1 AND kind = ?2 AND idempotency_key_hash = ?3`,
    )
      .bind(wallet.id, kind, idempotencyKeyHash)
      .first<{ id: string; payload_hash: string; status: string }>();
    if (existing) {
      return context.json({ intentId: existing.id, status: existing.status, replayed: true });
    }

    const intentId = `mint_${crypto.randomUUID()}`;
    const timestamp = now();
    const slippageBps = body.slippageBps as number;
    const amountTokenDesired = BigInt(body.amountToken as string);
    const amountUsdcDesired = BigInt(body.amountUsdc as string);
    const tickLower = body.tickLower as number;
    const tickUpper = body.tickUpper as number;
    // The request names the token and USDC amounts; the pool lists its tokens in its own order.
    const tokenIsZero = selectedPool.token0.address === requestedTokenAddress;
    const amount0Desired = tokenIsZero ? amountTokenDesired : amountUsdcDesired;
    const amount1Desired = tokenIsZero ? amountUsdcDesired : amountTokenDesired;

    let probeMint: Mint;
    try {
      probeMint = buildMint({ pool: selectedPool, recipient: wallet.address, tickLower, tickUpper,
        amount0Desired, amount1Desired, slippageBps, deadline, amount0Min: 0n, amount1Min: 0n });
    } catch {
      throw new AuthError("INVALID_MINT_REQUEST", 400);
    }

    const client = (
      dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })
    ) as unknown as ApprovalRouteClient & {
      getBalance(input: { address: Address }): Promise<bigint>;
      estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
    };
    const poolColumns = [
      requestedTokenAddress, discoveredToken.symbol, discoveredToken.decimals, selectedPool.address,
      selectedPool.token0.address, selectedPool.token1.address, selectedPool.fee, selectedPool.tickSpacing,
    ] as const;

    try {
      const block = await client.getBlock({ blockTag: "safe" });
      if (block.number === null || block.hash === null) throw new Error("No safe block");

      const simulation = await simulateMint({ client, owner: wallet.address, mint: probeMint, blockNumber: block.number });
      const simulatedAmount0 = BigInt(simulation.amount0);
      const simulatedAmount1 = BigInt(simulation.amount1);
      const slippageFactor = 10_000n - BigInt(slippageBps);
      const amount0Min = (simulatedAmount0 * slippageFactor) / 10_000n;
      const amount1Min = (simulatedAmount1 * slippageFactor) / 10_000n;
      const mint = buildMint({ pool: selectedPool, recipient: wallet.address, tickLower, tickUpper,
        amount0Desired: simulatedAmount0, amount1Desired: simulatedAmount1, slippageBps, deadline,
        amount0Min, amount1Min });

      const [nativeBalance, fees] = await Promise.all([
        client.getBalance({ address: wallet.address }),
        client.estimateFeesPerGas(),
      ]);
      const reserve = (BigInt(simulation.gasEstimate) * 120n * fees.maxFeePerGas + 99n) / 100n;
      const usdcForMint = tokenIsZero ? mint.amount1Desired : mint.amount0Desired;
      if (!canSpendArcUsdc(nativeBalance, usdcForMint, reserve)) {
        throw new AuthError("INSUFFICIENT_USDC_AFTER_FEES", 422);
      }

      const payloadHash = mintPayloadHash(mint);
      await context.env.DB.prepare(
        `INSERT INTO wallet_intents (
          id, wallet_id, kind, payload_hash, status, expires_at, created_at,
          updated_at, idempotency_key_hash, automation_run_id
        ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
      )
        .bind(intentId, wallet.id, kind, payloadHash, Number(deadline) * 1_000,
          timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null)
        .run();

      await context.env.DB.prepare(
        `INSERT INTO mint_intents (
          intent_id, chain_id, position_manager, recipient, tick_lower, tick_upper,
          amount0_desired, amount1_desired, amount0_min,
          amount1_min, slippage_bps, deadline, calldata, simulation_block,
          simulation_block_hash, gas_estimate, simulated_token_id, simulated_liquidity,
          simulated_amount0, simulated_amount1, created_at,
          token_address, token_symbol, token_decimals, pool_address,
          token0_address, token1_address, fee, tick_spacing
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)`,
      )
        .bind(
          intentId, mint.chainId, mint.to, mint.recipient, mint.tickLower,
          mint.tickUpper, mint.amount0Desired.toString(),
          mint.amount1Desired.toString(), mint.amount0Min.toString(),
          mint.amount1Min.toString(), mint.slippageBps, mint.deadline.toString(),
          mint.data, Number(block.number), block.hash,
          simulation.gasEstimate, simulation.tokenId, simulation.liquidity,
          simulatedAmount0.toString(), simulatedAmount1.toString(), timestamp,
          ...poolColumns,
        )
        .run();

      return context.json({
        intentId,
        status: "pending",
        transaction: {
          chainId: mint.chainId,
          to: mint.to,
          data: mint.data,
          value: "0",
        },
        constraints: {
          recipient: mint.recipient,
          tickLower: mint.tickLower,
          tickUpper: mint.tickUpper,
          amount0Min: mint.amount0Min.toString(),
          amount1Min: mint.amount1Min.toString(),
          tokenAddress: requestedTokenAddress,
          poolAddress: selectedPool.address,
          token0: selectedPool.token0.address,
          token1: selectedPool.token1.address,
          fee: selectedPool.fee,
          deadline: mint.deadline.toString(),
        },
        simulation: { ...simulation, blockHash: block.hash },
      }, 201);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      console.warn("Mint simulation rejected", intentId, error);
      const fallbackPayloadHash = mintPayloadHash(probeMint);
      await context.env.DB.prepare(
        `INSERT INTO wallet_intents (
          id, wallet_id, kind, payload_hash, status, failure_reason, expires_at, created_at,
          updated_at, idempotency_key_hash, automation_run_id
        ) VALUES (?1, ?2, ?3, ?4, 'rejected', 'MINT_SIMULATION_FAILED', ?5, ?6, ?6, ?7, ?8)`,
      )
        .bind(intentId, wallet.id, kind, fallbackPayloadHash, Number(deadline) * 1_000,
          timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null)
        .run();
      await context.env.DB.prepare(
        `INSERT INTO mint_intents (
          intent_id, chain_id, position_manager, recipient, tick_lower, tick_upper,
          amount0_desired, amount1_desired, amount0_min,
          amount1_min, slippage_bps, deadline, calldata, created_at,
          token_address, token_symbol, token_decimals, pool_address,
          token0_address, token1_address, fee, tick_spacing
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`,
      )
        .bind(intentId, probeMint.chainId, probeMint.to, probeMint.recipient, probeMint.tickLower,
          probeMint.tickUpper, probeMint.amount0Desired.toString(),
          probeMint.amount1Desired.toString(), probeMint.amount0Min.toString(),
          probeMint.amount1Min.toString(), probeMint.slippageBps, probeMint.deadline.toString(),
          probeMint.data, timestamp, ...poolColumns)
        .run();
      return context.json({ error: "MINT_SIMULATION_FAILED", intentId }, 422);
    }
  });

  app.post("/v1/wallets/positions/actions/prepare", async (context) => {
    const body = record(await jsonBody(context));
    const actionKind = ((body.action ?? body.kind) as string) ?? "";
    if (
      actionKind !== "increase" && actionKind !== "decrease" &&
      actionKind !== "collect" && actionKind !== "withdraw"
    ) throw new AuthError("INVALID_POSITION_ACTION", 400);
    if (
      typeof body.tokenId !== "string" || !/^[1-9][0-9]*$/.test(body.tokenId) ||
      typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
      body.idempotencyKey.length > 200
    ) throw new AuthError("INVALID_POSITION_ACTION", 400);

    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state FROM managed_wallets WHERE user_id = ?1",
    ).bind(context.get("user").id)
      .first<{ id: string; address: Address; state: string }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    if (
      (actionKind === "increase" && wallet.state !== "active") ||
      (actionKind !== "increase" && wallet.state !== "active" && wallet.state !== "paused")
    ) return context.json({ error: "WALLET_NOT_ACTIONABLE" }, 409);

    const client = (
      dependencies.createChainClient?.(context.env) ??
      createPublicClient({ chain: arc, transport: http(context.env.ARC_RPC_URL), batch: { multicall: true } })
    ) as unknown as PositionRouteClient;
    const block = await client.getBlock({ blockTag: "safe" });
    if (block.number === null || block.hash === null) {
      return context.json({ error: "CHAIN_READ_FAILED" }, 502);
    }
    const tokenId = BigInt(body.tokenId);
    let position;
    try {
      position = await verifyV3Position({
        client, owner: wallet.address, tokenId, blockNumber: block.number,
      });
    } catch {
      return context.json({ error: "POSITION_NOT_ACTIONABLE" }, 422);
    }

    const unsigned = (value: unknown) =>
      typeof value === "string" && /^[0-9]+$/.test(value);
    const positive = (value: unknown) =>
      typeof value === "string" && /^[1-9][0-9]*$/.test(value);
    const deadline = actionKind === "collect" ? 0n
      : positive(body.deadline) ? BigInt(body.deadline as string) : -1n;
    const nowSeconds = BigInt(Math.floor(now() / 1_000));
    if (
      actionKind !== "collect" &&
      (deadline < nowSeconds + 60n || deadline > nowSeconds + 30n * 60n)
    ) throw new AuthError("INVALID_POSITION_DEADLINE", 400);
    if (actionKind !== "collect" && (
      typeof body.slippageBps !== "number" ||
      !Number.isInteger(body.slippageBps)
    )) throw new AuthError("INVALID_POSITION_ACTION", 400);

    // Amounts are the position's token0 and token1 amounts, whichever tokens those are.
    let action;
    let expected0Record: string | null = null;
    let expected1Record: string | null = null;
    try {
      if (actionKind === "increase") {
        if (!unsigned(body.amount0) || !unsigned(body.amount1)) throw new Error();
        const effectiveSlippageBps = Math.max(body.slippageBps as number, 500);
        action = buildIncreaseLiquidity({
          tokenId, recipient: wallet.address,
          amount0: BigInt(body.amount0 as string),
          amount1: BigInt(body.amount1 as string),
          slippageBps: effectiveSlippageBps, deadline,
        });
      } else if (actionKind === "collect") {
        action = buildCollectAll({ tokenId, recipient: wallet.address });
      } else {
        const liquidity = actionKind === "withdraw"
          ? BigInt(position.liquidity)
          : positive(body.liquidity) ? BigInt(body.liquidity as string) : -1n;
        if (liquidity <= 0n || liquidity > BigInt(position.liquidity)) throw new Error();

        let expected0 = 0n;
        let expected1 = 0n;
        const hasExpected =
          unsigned(body.expected0) && unsigned(body.expected1) &&
          (BigInt(body.expected0 as string) > 0n || BigInt(body.expected1 as string) > 0n);

        if (hasExpected) {
          expected0 = BigInt(body.expected0 as string);
          expected1 = BigInt(body.expected1 as string);
        } else {
          // Probe-simulate decreaseLiquidity with 0 min amounts to discover exact tokens returned
          const probeAction = {
            chainId: ARC_CHAIN_ID as typeof ARC_CHAIN_ID,
            kind: "decrease" as const,
            tokenId,
            to: UNISWAP_V3_ARC.nonfungiblePositionManager.address,
            data: encodeFunctionData({
              abi: managerAbi,
              functionName: "decreaseLiquidity",
              args: [{
                tokenId,
                liquidity,
                amount0Min: 0n,
                amount1Min: 0n,
                deadline,
              }],
            }),
            value: 0n as 0n,
            recipient: wallet.address,
          };
          const probeSimulation = await simulatePositionAction({
            client,
            owner: wallet.address,
            action: probeAction,
            blockNumber: block.number,
          });
          const output = probeSimulation.output as { amount0: string; amount1: string };
          expected0 = BigInt(output.amount0);
          expected1 = BigInt(output.amount1);
        }

        expected0Record = expected0.toString();
        expected1Record = expected1.toString();

        const effectiveSlippageBps = Math.max(body.slippageBps as number, 500);
        const parameters = {
          tokenId, recipient: wallet.address, liquidity,
          expected0,
          expected1,
          slippageBps: effectiveSlippageBps, deadline,
        };
        action = actionKind === "withdraw"
          ? buildFullWithdrawal(parameters)
          : buildDecreaseLiquidity(parameters);
      }
    } catch (error) {
      console.warn("Position action build failed", error);
      throw new AuthError("INVALID_POSITION_ACTION", 400);
    }

    const timestamp = now();
    const intentId = `position_${crypto.randomUUID()}`;
    const kind = `position_${action.kind}`;
    const payloadHash = positionActionPayloadHash(action);
    const idempotencyKeyHash = await hashOpaqueValue(body.idempotencyKey);
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO wallet_intents (
        id, wallet_id, kind, payload_hash, status, expires_at, created_at,
        updated_at, idempotency_key_hash, automation_run_id
      ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6, ?7, ?8)`,
    ).bind(intentId, wallet.id, kind, payloadHash,
      timestamp + 10 * 60 * 1_000, timestamp, idempotencyKeyHash, context.get("agentRun")?.id ?? null).run();
    const stored = await context.env.DB.prepare(
      `SELECT id, payload_hash, status FROM wallet_intents
       WHERE wallet_id = ?1 AND kind = ?2 AND idempotency_key_hash = ?3`,
    ).bind(wallet.id, kind, idempotencyKeyHash)
      .first<{ id: string; payload_hash: string; status: string }>();
    if (!stored) throw new Error("Position action intent was not persisted");
    if (stored.payload_hash !== payloadHash) {
      return context.json({ error: "IDEMPOTENCY_KEY_REUSED" }, 409);
    }
    if (stored.id !== intentId) {
      return context.json({ intentId: stored.id, status: stored.status, replayed: true });
    }
    await context.env.DB.prepare(
      `INSERT INTO position_action_intents (
        intent_id, action, chain_id, position_manager, token_id, recipient,
        calldata, constraints_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(intentId, action.kind, action.chainId, action.to,
      action.tokenId.toString(), action.recipient, action.data,
      JSON.stringify({
        action: action.kind,
        tokenId: action.tokenId.toString(),
        verifiedLiquidity: position.liquidity,
        slippageBps: action.kind === "collect" ? null : body.slippageBps,
        deadline: action.kind === "collect" ? null : deadline.toString(),
        expected0: expected0Record,
        expected1: expected1Record,
      }), timestamp).run();

    try {
      const simulation = await simulatePositionAction({
        client, owner: wallet.address, action, blockNumber: block.number,
      });
      await context.env.DB.prepare(
        `UPDATE position_action_intents SET simulation_block = ?2,
          simulation_block_hash = ?3, gas_estimate = ?4,
          simulation_output_json = ?5 WHERE intent_id = ?1`,
      ).bind(intentId, Number(block.number), block.hash,
        simulation.gasEstimate, JSON.stringify(simulation.output)).run();
      return context.json({
        intentId, status: "pending", action: action.kind,
        transaction: { chainId: action.chainId, to: action.to,
          data: action.data, value: "0" },
        simulation: { ...simulation, blockHash: block.hash },
      }, 201);
    } catch {
      console.warn("Position action simulation rejected", intentId);
      await context.env.DB.prepare(
        `UPDATE wallet_intents SET status = 'rejected',
          failure_reason = 'POSITION_ACTION_SIMULATION_FAILED', updated_at = ?2
         WHERE id = ?1 AND status = 'pending'`,
      ).bind(intentId, now()).run();
      return context.json({
        error: "POSITION_ACTION_SIMULATION_FAILED", intentId,
      }, 422);
    }
  });

  app.post("/v1/wallets/intents/:intentId/execute", async (context) => {
    const intentId = context.req.param("intentId");
    if (!isIdentifier(intentId)) {
      return context.json({ error: "INVALID_REQUEST" }, 400);
    }
    // The agent may only send what its own run prepared.
    const owned = await context.env.DB.prepare(
      `SELECT wi.id, mw.id AS wallet_id
       FROM wallet_intents wi
       JOIN managed_wallets mw ON mw.id = wi.wallet_id
       WHERE wi.id = ?1 AND mw.user_id = ?2 AND (?3 IS NULL OR wi.automation_run_id = ?3)`,
    ).bind(intentId, context.get("user").id, context.get("agentRun")?.id ?? null)
      .first<{ id: string; wallet_id: string }>();
    if (!owned) return context.json({ error: "INTENT_NOT_FOUND" }, 404);

    // If wallet has a submitted attempt, reconcile it first before failing with WALLET_EXECUTION_BUSY!
    const pendingAttempt = await context.env.DB.prepare(
      "SELECT id FROM mainnet_transaction_attempts WHERE wallet_id = ?1 AND status = 'submitted' LIMIT 1",
    )
      .bind(owned.wallet_id)
      .first<{ id: string }>();

    if (pendingAttempt) {
      try {
        await context.env.SIGNER.fetch(
          new Request("http://stillwater-signer/internal/v1/attempts/reconcile-mainnet", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attemptId: pendingAttempt.id }),
          }),
        );
      } catch (err) {
        console.warn("Pre-execution reconciliation error", err);
      }
    }

    const response = await context.env.SIGNER.fetch(
      new Request("http://stillwater-signer/internal/v1/intents/execute-mainnet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intentId }),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.post("/v1/wallets/attempts/:attemptId/reconcile", async (context) => {
    const attemptId = context.req.param("attemptId");
    if (!isIdentifier(attemptId)) {
      return context.json({ error: "INVALID_REQUEST" }, 400);
    }
    const owned = await context.env.DB.prepare(
      `SELECT mta.id
       FROM mainnet_transaction_attempts mta
       JOIN managed_wallets mw ON mw.id = mta.wallet_id
       WHERE mta.id = ?1 AND mw.user_id = ?2`,
    ).bind(attemptId, context.get("user").id).first<{ id: string }>();
    if (!owned) return context.json({ error: "ATTEMPT_NOT_FOUND" }, 404);

    const response = await context.env.SIGNER.fetch(
      new Request("http://stillwater-signer/internal/v1/attempts/reconcile-mainnet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.post("/v1/wallets/pause", async (context) => {
    const user = context.get("user");
    await context.env.DB.prepare(
      `UPDATE managed_wallets SET state = 'paused', updated_at = ?2
       WHERE user_id = ?1 AND state = 'active'`,
    )
      .bind(user.id, now())
      .run();
    const wallet = await context.env.DB.prepare(
      "SELECT id, address, state, updated_at FROM managed_wallets WHERE user_id = ?1",
    )
      .bind(user.id)
      .first<{ id: string; address: string; state: string; updated_at: number }>();
    if (!wallet) return context.json({ error: "WALLET_NOT_FOUND" }, 404);
    return context.json({ wallet });
  });

  return app;
}

function requireSession(now: () => number) {
  return async (
    context: Context<AppEnvironment>,
    next: () => Promise<void>,
  ) => {
    // agentIdentity already set the user for the automation Worker's requests.
    if (context.get("agentRun")) return next();
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return context.json({ error: "UNAUTHENTICATED" }, 401);

    const tokenHash = await hashOpaqueValue(token);
    const user = await context
      .get("authStore")
      .findSessionUser(tokenHash, now());
    if (!user) return context.json({ error: "UNAUTHENTICATED" }, 401);

    context.set("user", user);
    context.set("sessionTokenHash", tokenHash);
    await next();
  };
}

export default createApp();
