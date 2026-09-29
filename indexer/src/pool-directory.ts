import {
  ARC_CHAIN_ID,
  ARC_TOKENS,
  UNISWAP_V3_ARC,
  discoverArcTokenPools,
  type PoolDiscoveryClient,
} from "@stillwater/chain";
import { getAddress, parseAbi, type Address, type Hex } from "viem";

const factoryEvent = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
])[0];
const usdcAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const CHECKPOINT = "pool_directory";
const BLOCKS_PER_RUN = 100_000n;
const LOG_CHUNK = 10_000n;

type DirectoryClient = PoolDiscoveryClient & {
  getBlock(parameters: { blockTag: "safe" } | { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
  getLogs(parameters: {
    address: Address;
    event: typeof factoryEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Array<{ args: { token0?: Address; token1?: Address; pool?: Address } }>>;
};

export async function indexPoolDirectory(input: {
  db: D1Database;
  client: DirectoryClient;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const block = await input.client.getBlock({ blockTag: "safe" });
  if (block.number === null) throw new Error("Arc safe block unavailable");
  const checkpoint = await input.db.prepare(
    "SELECT block_number FROM chain_indexer_checkpoints WHERE name = ?1",
  ).bind(CHECKPOINT).first<{ block_number: number }>();
  const first = BigInt(checkpoint?.block_number ?? -1) + 1n;
  const last = first + BLOCKS_PER_RUN - 1n < block.number
    ? first + BLOCKS_PER_RUN - 1n : block.number;
  const tokens = new Set<Address>([ARC_TOKENS.cirBTC.address]);

  for (let fromBlock = first; fromBlock <= last; fromBlock += LOG_CHUNK) {
    const toBlock = fromBlock + LOG_CHUNK - 1n < last ? fromBlock + LOG_CHUNK - 1n : last;
    const logs = await input.client.getLogs({
      address: UNISWAP_V3_ARC.factory.address,
      event: factoryEvent,
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      if (!log.args.token0 || !log.args.token1 || !log.args.pool) continue;
      const token0 = getAddress(log.args.token0);
      const token1 = getAddress(log.args.token1);
      if (token0 === ARC_TOKENS.USDC.address) tokens.add(token1);
      if (token1 === ARC_TOKENS.USDC.address) tokens.add(token0);
    }
  }

  // Refresh existing entries too; a pool may become initialized or gain liquidity later.
  const stored = await input.db.prepare(
    "SELECT DISTINCT token_address FROM pool_directory",
  ).all<{ token_address: Address }>();
  for (const row of stored.results) tokens.add(getAddress(row.token_address));

  for (const tokenAddress of tokens) {
    try {
      const discovered = await discoverArcTokenPools({
        client: input.client,
        tokenAddress,
        blockNumber: block.number,
      });
      for (const pool of discovered.pools) {
        if (BigInt(pool.liquidity) === 0n) {
          await input.db.prepare("DELETE FROM pool_directory WHERE pool_address = ?1")
            .bind(pool.address).run();
          continue;
        }
        const reserve = await input.client.readContract({
          address: ARC_TOKENS.USDC.address,
          abi: usdcAbi,
          functionName: "balanceOf",
          args: [pool.address],
          blockNumber: block.number,
        });
        if (typeof reserve !== "bigint") continue;
        await input.db.prepare(
          `INSERT INTO pool_directory (
            pool_address, token_address, token_symbol, token_decimals,
            token0_address, token1_address, fee, tick_spacing, sqrt_price_x96,
            tick, liquidity, usdc_reserve, block_number, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
          ON CONFLICT(pool_address) DO UPDATE SET
            token_symbol=excluded.token_symbol, token_decimals=excluded.token_decimals,
            sqrt_price_x96=excluded.sqrt_price_x96, tick=excluded.tick,
            liquidity=excluded.liquidity, usdc_reserve=excluded.usdc_reserve,
            block_number=excluded.block_number, updated_at=excluded.updated_at`,
        ).bind(
          pool.address, tokenAddress, discovered.token.symbol, discovered.token.decimals,
          pool.token0.address, pool.token1.address, pool.fee, pool.tickSpacing,
          pool.sqrtPriceX96, pool.tick, pool.liquidity, reserve.toString(),
          Number(block.number), now(),
        ).run();
      }
    } catch (error) {
      // An adversarial token must not prevent other pools or managed wallets from indexing.
      console.warn("Pool directory skipped token", tokenAddress, error);
    }
  }

  if (first <= last) {
    const finalBlock = await input.client.getBlock({ blockNumber: last });
    await input.db.prepare(
      `INSERT INTO chain_indexer_checkpoints
       (name, chain_id, block_number, block_hash, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(name) DO UPDATE SET block_number=excluded.block_number,
         block_hash=excluded.block_hash, updated_at=excluded.updated_at`,
    ).bind(CHECKPOINT, ARC_CHAIN_ID, Number(last), finalBlock.hash ?? "0x", now()).run();
  }
}
