import {
  ARC_TOKENS,
  buildArcV4Mint,
  buildArcV4Approval,
  buildArcV4Swap,
  buildArcV4PositionAction,
  readArcV4Position,
  quoteArcV4Swap,
  readArcV4Pool,
  readV3PoolAddress,
  positionManagerAbi,
  quoteSwap,
  type Swap,
  withdrawalDomain,
  withdrawalMessage,
  withdrawalTypes,
  type UsdcWithdrawal,
  verifyV3Position,
  verifyArcPoolAddress,
  verifyArcSelectedPool,
  type ChainReadClient,
  type ArcV4Pool,
  type PoolDiscoveryClient,
  usdcValue,
} from "@stillwater/chain";
import { decodeFunctionData, verifyTypedData, type Address, type Hex } from "viem";
import {
  validateMainnetIntent,
  type MainnetIntentKind,
  type MainnetPolicyRequest,
} from "./mainnet-policy";
import type { WalletState } from "./policy";
import { validateMandate, type AutomationContext } from "./mandate-policy";

export type CustodyWallet = {
  walletId: string;
  circleWalletId: string;
  address: Address;
};

export type LoadedMainnetIntent = {
  intentId: string;
  kind: MainnetIntentKind;
  status: string;
  expiresAt: number;
  payloadHash: Hex;
  wallet: { address: Address; state: WalletState };
  transaction: { chainId: number; to: Address; data: Hex; value: bigint };
  approvalPool?: { tokenAddress: Address; poolAddress: Address; poolTokenAddress: Address; tokenDecimals?: number };
  mintPool?: {
    poolAddress: Address;
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
    tokenDecimals?: number;
  };
  v4Mint?: {
    pool: ArcV4Pool;
    tokenDecimals: number;
    recipient: Address;
    tickLower: number;
    tickUpper: number;
    amount0Desired: bigint;
    amount1Desired: bigint;
    slippageBps: number;
    deadline: bigint;
  };
  v4Approval?: {
    pool: ArcV4Pool;
    token: Address;
    tokenDecimals: number;
    stage: "erc20" | "permit2";
    amount: bigint;
    expiration: bigint;
    spender: Address;
  };
  v4Swap?: { pool: ArcV4Pool; tokenIn: Address; amountIn: bigint;
    amountOutMinimum: bigint; deadline: bigint };
  v4PositionAction?: { kind: "collect" | "withdraw"; poolId: Hex; tokenId: bigint;
    tickLower: number; tickUpper: number; liquidity: bigint; tokenDecimals: number;
    slippageBps: number; deadline: bigint; recipient: Address };
  tokenId?: bigint;
  expected0?: bigint;
  expected1?: bigint;
  withdrawal?: {
    transaction: UsdcWithdrawal;
    ownerAddress: Address;
    signature: Hex;
  };
  swap?: { transaction: Swap; tokenAddress: Address; tokenDecimals: number };
  /** The Circle wallet that signs for this Stillwater wallet. */
  custody?: CustodyWallet;
  /** Set when the automation agent made this request rather than the user. */
  automation?: AutomationContext;
};

export type MainnetEvaluation = {
  intentId: string;
  decision: "allowed" | "rejected";
  reasonCode: string;
  blockNumber: number | null;
  createdAt: number;
};

export interface MainnetEvaluationStore {
  load(intentId: string): Promise<LoadedMainnetIntent | null>;
  save(evaluation: MainnetEvaluation): Promise<void>;
}

export type MainnetAuditClient = ChainReadClient & {
  getBlock(parameters: { blockTag: "safe" }): Promise<{
    number: bigint | null;
    hash: Hex | null;
  }>;
  call(parameters: {
    account: Address;
    to: Address;
    data: Hex;
    value: bigint;
    blockNumber?: bigint;
  }): Promise<unknown>;
  getCode?(parameters: { address: Address; blockNumber?: bigint }): Promise<`0x${string}` | undefined>;
};

export class MainnetEvaluationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function evaluateMainnetIntent(input: {
  intentId: string;
  store: MainnetEvaluationStore;
  client: MainnetAuditClient;
  emergencyStop: boolean;
  now?: () => number;
}): Promise<MainnetEvaluation> {
  const loaded = await input.store.load(input.intentId);
  if (!loaded) throw new MainnetEvaluationError("MAINNET_INTENT_NOT_FOUND", 404);
  return evaluateLoadedMainnetIntent({ ...input, loaded });
}

export async function evaluateLoadedMainnetIntent(input: {
  loaded: LoadedMainnetIntent;
  store: Pick<MainnetEvaluationStore, "save">;
  client: MainnetAuditClient;
  emergencyStop: boolean;
  now?: () => number;
}): Promise<MainnetEvaluation> {
  const now = input.now ?? Date.now;
  const loaded = input.loaded;
  const safeBlock = await input.client.getBlock({ blockTag: "safe" });
  if (safeBlock.number === null || safeBlock.hash === null) {
    throw new MainnetEvaluationError("ARC_SAFE_BLOCK_UNAVAILABLE", 503);
  }

  let position: MainnetPolicyRequest["position"];
  let withdrawal: MainnetPolicyRequest["withdrawal"];
  let swap: MainnetPolicyRequest["swap"];
  let v4Mint: MainnetPolicyRequest["v4Mint"];
  let v4Approval: MainnetPolicyRequest["v4Approval"];
  let v4Swap: MainnetPolicyRequest["v4Swap"];
  let v4PositionAction: MainnetPolicyRequest["v4PositionAction"];
  // What an agent's mint or swap puts into the pool, at the price just read.
  let depositValue: ReturnType<typeof usdcValue> | undefined;
  // The v3 pool a request works in, for holding an agent to its mandate.
  let v3PoolAddress: Address | undefined;
  try {
    if (loaded.v4PositionAction) {
      const stored = loaded.v4PositionAction;
      const position = await readArcV4Position({ client: input.client,
        tokenId: stored.tokenId, owner: loaded.wallet.address, blockNumber: safeBlock.number });
      if (position.poolId.toLowerCase() !== stored.poolId.toLowerCase() ||
          position.tickLower !== stored.tickLower || position.tickUpper !== stored.tickUpper ||
          position.liquidity !== stored.liquidity || position.liquidity <= 0n ||
          stored.recipient.toLowerCase() !== loaded.wallet.address.toLowerCase()) {
        throw new Error("V4 position changed");
      }
      const pool = await readArcV4Pool({ client: input.client, key: position.poolKey,
        blockNumber: safeBlock.number });
      if (!pool) throw new Error("V4 pool unavailable");
      const token = pool.currency0 === ARC_TOKENS.USDC.address ||
        pool.currency0 === "0x0000000000000000000000000000000000000000"
        ? pool.currency1 : pool.currency0;
      const decimals = await input.client.readContract({ address: token,
        abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [],
          outputs: [{ type: "uint8" }] }], functionName: "decimals",
        blockNumber: safeBlock.number });
      if (decimals !== stored.tokenDecimals) throw new Error("V4 token decimals changed");
      const transaction = buildArcV4PositionAction({ ...stored, pool });
      v4PositionAction = { transaction };
    }
    if (loaded.v4Approval) {
      const stored = loaded.v4Approval;
      const fresh = await readArcV4Pool({ client: input.client, key: stored.pool,
        blockNumber: safeBlock.number });
      if (!fresh || fresh.id !== stored.pool.id || BigInt(fresh.liquidity) <= 0n ||
          (stored.token !== fresh.currency0 && stored.token !== fresh.currency1) ||
          stored.token === "0x0000000000000000000000000000000000000000") {
        throw new Error("V4 approval pool unavailable");
      }
      const decimals = await input.client.readContract({ address: stored.token,
        abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [],
          outputs: [{ type: "uint8" }] }], functionName: "decimals", blockNumber: safeBlock.number });
      if (decimals !== stored.tokenDecimals) throw new Error("V4 approval token decimals changed");
      const transaction = buildArcV4Approval({ poolId: fresh.id, token: stored.token,
        stage: stored.stage, amount: stored.amount, expiration: stored.expiration,
        spender: stored.spender });
      v4Approval = { transaction };
    }
    if (loaded.v4Swap) {
      const stored = loaded.v4Swap;
      const fresh = await readArcV4Pool({ client: input.client, key: stored.pool,
        blockNumber: safeBlock.number });
      if (!fresh || fresh.id !== stored.pool.id || BigInt(fresh.liquidity) <= 0n) {
        throw new Error("V4 swap pool unavailable");
      }
      const transaction = buildArcV4Swap({ pool: fresh, tokenIn: stored.tokenIn,
        amountIn: stored.amountIn, amountOutMinimum: stored.amountOutMinimum,
        deadline: stored.deadline });
      const quoted = await quoteArcV4Swap({ client: input.client, pool: fresh,
        account: loaded.wallet.address, tokenIn: stored.tokenIn,
        amountIn: stored.amountIn, blockNumber: safeBlock.number });
      v4Swap = { transaction, freshAmountOut: quoted.amountOut };
      depositValue = usdcValue({ pool: fresh,
        amount0: stored.tokenIn.toLowerCase() === fresh.currency0.toLowerCase() ? stored.amountIn : 0n,
        amount1: stored.tokenIn.toLowerCase() === fresh.currency1.toLowerCase() ? stored.amountIn : 0n });
    }
    if (loaded.v4Mint) {
      const stored = loaded.v4Mint;
      const fresh = await readArcV4Pool({ client: input.client, key: stored.pool,
        blockNumber: safeBlock.number });
      if (!fresh || fresh.id !== stored.pool.id || BigInt(fresh.liquidity) <= 0n) {
        throw new Error("V4 pool unavailable");
      }
      const token = stored.pool.currency0 === ARC_TOKENS.USDC.address ||
        stored.pool.currency0 === "0x0000000000000000000000000000000000000000"
        ? stored.pool.currency1 : stored.pool.currency0;
      const decimals = await input.client.readContract({ address: token,
        abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [],
          outputs: [{ type: "uint8" }] }], functionName: "decimals", blockNumber: safeBlock.number });
      if (decimals !== stored.tokenDecimals) throw new Error("V4 token decimals changed");
      v4Mint = { transaction: buildArcV4Mint(stored) };
      depositValue = usdcValue({ pool: fresh, amount0: stored.amount0Desired, amount1: stored.amount1Desired });
    }
    if (loaded.swap) {
      if (!input.client.getCode) throw new Error("Pool verification unavailable");
      const pool = await verifyArcPoolAddress({
        client: input.client as PoolDiscoveryClient,
        tokenAddress: loaded.swap.tokenAddress,
        poolAddress: loaded.swap.transaction.poolAddress,
        blockNumber: safeBlock.number,
      });
      if (pool.fee !== loaded.swap.transaction.fee || BigInt(pool.liquidity) === 0n) {
        throw new Error("Swap pool unavailable");
      }
      const quoted = await quoteSwap({
        client: input.client as unknown as Parameters<typeof quoteSwap>[0]["client"],
        pool,
        account: loaded.wallet.address,
        tokenIn: loaded.swap.transaction.tokenIn,
        tokenOut: loaded.swap.transaction.tokenOut,
        amountIn: loaded.swap.transaction.amountIn,
        blockNumber: safeBlock.number,
      });
      swap = { transaction: loaded.swap.transaction, tokenAddress: loaded.swap.tokenAddress,
        freshAmountOut: quoted.amountOut };
      v3PoolAddress = pool.address;
      const tokenIn = loaded.swap.transaction.tokenIn.toLowerCase();
      depositValue = usdcValue({ pool: { currency0: pool.token0.address, currency1: pool.token1.address,
        sqrtPriceX96: pool.sqrtPriceX96 },
        amount0: tokenIn === pool.token0.address.toLowerCase() ? loaded.swap.transaction.amountIn : 0n,
        amount1: tokenIn === pool.token1.address.toLowerCase() ? loaded.swap.transaction.amountIn : 0n });
    }
    if (loaded.withdrawal) {
      const signatureValid = await verifyTypedData({
        address: loaded.withdrawal.ownerAddress,
        domain: withdrawalDomain,
        types: withdrawalTypes,
        primaryType: "UsdcWithdrawal",
        message: withdrawalMessage(loaded.withdrawal.transaction),
        signature: loaded.withdrawal.signature,
      });
      withdrawal = {
        transaction: loaded.withdrawal.transaction,
        signature: loaded.withdrawal.signature,
        signatureValid,
      };
    }
    if (loaded.approvalPool) {
      if (!input.client.getCode) throw new Error("Pool verification unavailable");
      await verifyArcPoolAddress({
        client: input.client as PoolDiscoveryClient,
        tokenAddress: loaded.approvalPool.poolTokenAddress,
        poolAddress: loaded.approvalPool.poolAddress,
        blockNumber: safeBlock.number,
      });
      v3PoolAddress = loaded.approvalPool.poolAddress;
    }
    if (loaded.mintPool) {
      if (!input.client.getCode) throw new Error("Pool verification unavailable");
      const tokenAddress = loaded.mintPool.token0 === ARC_TOKENS.USDC.address
        ? loaded.mintPool.token1 : loaded.mintPool.token0;
      const selected = await verifyArcSelectedPool({
        client: input.client as PoolDiscoveryClient,
        token: { address: tokenAddress, symbol: "TOKEN", decimals: loaded.mintPool.tokenDecimals ?? 18 },
        pool: {
          address: loaded.mintPool.poolAddress,
          fee: loaded.mintPool.fee,
          tickSpacing: loaded.mintPool.tickSpacing,
          token0: {
            address: loaded.mintPool.token0,
            symbol: "TOKEN",
            decimals: loaded.mintPool.token0 === tokenAddress ? loaded.mintPool.tokenDecimals ?? 18 : 6,
          },
          token1: {
            address: loaded.mintPool.token1,
            symbol: "TOKEN",
            decimals: loaded.mintPool.token1 === tokenAddress ? loaded.mintPool.tokenDecimals ?? 18 : 6,
          },
        },
        blockNumber: safeBlock.number,
      });
      v3PoolAddress = selected.address;
      const decoded = decodeFunctionData({ abi: positionManagerAbi, data: loaded.transaction.data });
      if (decoded.functionName === "mint") {
        depositValue = usdcValue({ pool: { currency0: selected.token0.address, currency1: selected.token1.address,
          sqrtPriceX96: selected.sqrtPriceX96 }, amount0: decoded.args[0].amount0Desired,
          amount1: decoded.args[0].amount1Desired });
      }
    }
    if (loaded.tokenId !== undefined) {
      const current = await verifyV3Position({
        client: input.client,
        owner: loaded.wallet.address,
        tokenId: loaded.tokenId,
        blockNumber: safeBlock.number,
      });
      if (loaded.automation) {
        v3PoolAddress = await readV3PoolAddress(input.client, current, safeBlock.number);
      }
      position = {
        tokenId: loaded.tokenId,
        owner: loaded.wallet.address,
        liquidity: BigInt(current.liquidity),
        expected0: loaded.expected0,
        expected1: loaded.expected1,
      };
    }
    await input.client.call({
      account: loaded.wallet.address,
      to: loaded.transaction.to,
      data: loaded.transaction.data,
      value: loaded.transaction.value,
    });
  } catch (error) {
    console.error("Mainnet chain revalidation failed for intent:", loaded.intentId, error);
    const evaluation: MainnetEvaluation = {
      intentId: loaded.intentId,
      decision: "rejected",
      reasonCode: "CHAIN_REVALIDATION_FAILED",
      blockNumber: Number(safeBlock.number),
      createdAt: now(),
    };
    await input.store.save(evaluation);
    return evaluation;
  }

  if (loaded.automation) {
    const mandate = validateMandate({
      automation: loaded.automation,
      kind: loaded.kind,
      walletState: loaded.wallet.state,
      poolId: loaded.v4Mint?.pool.id ?? loaded.v4Approval?.pool.id ?? loaded.v4Swap?.pool.id ??
        loaded.v4PositionAction?.poolId ?? v3PoolAddress,
      value: depositValue ?? undefined,
    });
    if (!mandate.allowed) {
      const evaluation: MainnetEvaluation = {
        intentId: loaded.intentId,
        decision: "rejected",
        reasonCode: mandate.reason,
        blockNumber: Number(safeBlock.number),
        createdAt: now(),
      };
      await input.store.save(evaluation);
      return evaluation;
    }
  }

  const decision = validateMainnetIntent({
    now: now(),
    emergencyStop: input.emergencyStop,
    wallet: loaded.wallet,
    intent: {
      kind: loaded.kind,
      status: loaded.status,
      expiresAt: loaded.expiresAt,
      payloadHash: loaded.payloadHash,
    },
    transaction: loaded.transaction,
    approval: loaded.approvalPool,
    mintPool: loaded.mintPool,
    v4Mint,
      v4Approval,
    v4Swap,
    v4PositionAction,
    position,
    withdrawal,
    swap,
    simulation: {
      success: true,
      blockNumber: safeBlock.number,
      latestBlockNumber: safeBlock.number,
    },
  });
  const evaluation: MainnetEvaluation = {
    intentId: loaded.intentId,
    decision: decision.allowed ? "allowed" : "rejected",
    reasonCode: decision.reason,
    blockNumber: Number(safeBlock.number),
    createdAt: now(),
  };
  await input.store.save(evaluation);
  return evaluation;
}
