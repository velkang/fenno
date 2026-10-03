import { getAddress, type Hex } from "viem";
import { buildSwap, buildUsdcWithdrawal, UNISWAP_SHARED_ARC, UNISWAP_V4_ARC } from "@stillwater/chain";
import type {
  LoadedMainnetIntent,
  MainnetEvaluation,
  MainnetEvaluationStore,
} from "./mainnet-evaluator";
import type { MainnetIntentKind } from "./mainnet-policy";
import type { WalletState } from "./policy";

type Row = {
  v4_mint_json: string;
  v4_approval_json: string;
  v4_swap_json: string;
  v4_position_action_json: string;
  intent_id: string;
  kind: MainnetIntentKind;
  status: string;
  expires_at: number;
  payload_hash: Hex;
  wallet_address: string;
  wallet_state: WalletState;
  root_owner_address: string;
  approval_chain_id: number | null;
  approval_target: string | null;
  approval_pool_address: string | null;
  approval_pool_token_address: string | null;
  approval_token_decimals: number | null;
  approval_calldata: Hex | null;
  mint_chain_id: number | null;
  mint_target: string | null;
  mint_calldata: Hex | null;
  mint_pool_address: string | null;
  mint_token0_address: string | null;
  mint_token1_address: string | null;
  mint_fee: number | null;
  mint_tick_spacing: number | null;
  mint_token_decimals: number | null;
  v4_pool_id: Hex | null;
  v4_currency0: string | null;
  v4_currency1: string | null;
  v4_fee: number | null;
  v4_tick_spacing: number | null;
  v4_hooks: string | null;
  v4_token_decimals: number | null;
  v4_sqrt_price_x96: string | null;
  v4_tick: number | null;
  v4_liquidity: string | null;
  v4_lp_fee: number | null;
  v4_recipient: string | null;
  v4_tick_lower: number | null;
  v4_tick_upper: number | null;
  v4_amount0_desired: string | null;
  v4_amount1_desired: string | null;
  v4_slippage_bps: number | null;
  v4_deadline: string | null;
  v4_calldata: Hex | null;
  v4_native_value: string | null;
  v4a_pool_id: Hex | null;
  v4a_currency0: string | null;
  v4a_currency1: string | null;
  v4a_fee: number | null;
  v4a_tick_spacing: number | null;
  v4a_hooks: string | null;
  v4a_token: string | null;
  v4a_token_decimals: number | null;
  v4a_stage: "erc20" | "permit2" | null;
  v4a_spender: string | null;
  v4a_amount: string | null;
  v4a_expiration: string | null;
  v4a_target: string | null;
  v4a_calldata: Hex | null;
  v4s_pool_id: Hex | null;
  v4s_currency0: string | null;
  v4s_currency1: string | null;
  v4s_fee: number | null;
  v4s_tick_spacing: number | null;
  v4s_hooks: string | null;
  v4s_token_in: string | null;
  v4s_amount_in: string | null;
  v4s_amount_out_minimum: string | null;
  v4s_deadline: string | null;
  v4s_calldata: Hex | null;
  v4s_native_value: string | null;
  v4pa_action: "collect" | "withdraw" | null;
  v4pa_pool_id: Hex | null;
  v4pa_token_id: string | null;
  v4pa_tick_lower: number | null;
  v4pa_tick_upper: number | null;
  v4pa_liquidity: string | null;
  v4pa_token_decimals: number | null;
  v4pa_slippage_bps: number | null;
  v4pa_deadline: string | null;
  v4pa_recipient: string | null;
  v4pa_calldata: Hex | null;
  action_chain_id: number | null;
  action_target: string | null;
  action_calldata: Hex | null;
  action_token_id: string | null;
  withdrawal_chain_id: number | null;
  withdrawal_calldata: Hex | null;
  withdrawal_recipient: string | null;
  withdrawal_amount: string | null;
  withdrawal_owner_address: string | null;
  withdrawal_owner_signature: Hex | null;
  withdrawal_nonce: Hex | null;
  withdrawal_expires_at: number | null;
  swap_chain_id: number | null;
  swap_calldata: Hex | null;
  swap_pool_address: string | null;
  swap_token_address: string | null;
  swap_token_decimals: number | null;
  swap_fee: number | null;
  swap_token_in: string | null;
  swap_token_out: string | null;
  swap_recipient: string | null;
  swap_amount_in: string | null;
  swap_amount_out_minimum: string | null;
  swap_deadline: number | null;
  constraints_json: string | null;
  wallet_id: string;
  circle_wallet_id: string | null;
  automation_json: string;
};

type AutomationRow = {
  run_id: string | null;
  run_status: string | null;
  mandate_id: string | null;
  mandate_status: string | null;
  mandate_pool_id: Hex | null;
  mandate_max_position_usd: number | null;
  mandate_max_runs_per_day: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

const allowedKinds = new Set<string>([
  "erc20_approval",
  "position_mint",
  "v4_position_mint",
  "v4_approval",
  "v4_single_pool_swap",
  "v4_position_collect",
  "v4_position_withdraw",
  "position_increase",
  "position_decrease",
  "position_collect",
  "position_withdraw",
  "usdc_withdrawal",
  "single_pool_swap",
]);

export class D1MainnetEvaluationStore implements MainnetEvaluationStore {
  constructor(private readonly db: D1Database) {}

  async load(intentId: string): Promise<LoadedMainnetIntent | null> {
    const row = await this.db.prepare(
      `SELECT wi.id AS intent_id, wi.kind, wi.status, wi.expires_at,
              wi.payload_hash, mw.address AS wallet_address,
              mw.state AS wallet_state, u.owner_address AS root_owner_address,
              mw.id AS wallet_id, mw.circle_wallet_id,
              ai.chain_id AS approval_chain_id,
              ai.token_address AS approval_target,
              ai.pool_address AS approval_pool_address,
              ai.pool_token_address AS approval_pool_token_address,
              ai.token_decimals AS approval_token_decimals,
              ai.calldata AS approval_calldata,
              mi.chain_id AS mint_chain_id,
              mi.position_manager AS mint_target,
              mi.calldata AS mint_calldata,
              mi.pool_address AS mint_pool_address,
              mi.token0_address AS mint_token0_address,
              mi.token1_address AS mint_token1_address,
              mi.fee AS mint_fee,
              mi.tick_spacing AS mint_tick_spacing,
              mi.token_decimals AS mint_token_decimals,
              -- Keep variant fields packed: D1 rejects the full joined projection as too wide.
              json_object('v4_pool_id', vmi.pool_id, 'v4_currency0', vmi.currency0,
                'v4_currency1', vmi.currency1, 'v4_fee', vmi.fee,
                'v4_tick_spacing', vmi.tick_spacing, 'v4_hooks', vmi.hooks,
                'v4_token_decimals', vmi.token_decimals, 'v4_sqrt_price_x96', vmi.sqrt_price_x96,
                'v4_tick', vmi.tick, 'v4_liquidity', vmi.liquidity,
                'v4_lp_fee', vmi.lp_fee, 'v4_recipient', vmi.recipient,
                'v4_tick_lower', vmi.tick_lower, 'v4_tick_upper', vmi.tick_upper,
                'v4_amount0_desired', vmi.amount0_desired, 'v4_amount1_desired', vmi.amount1_desired,
                'v4_slippage_bps', vmi.slippage_bps, 'v4_deadline', vmi.deadline,
                'v4_calldata', vmi.calldata, 'v4_native_value', vmi.native_value) AS v4_mint_json,
              json_object('v4a_pool_id', vai.pool_id, 'v4a_currency0', vai.currency0,
                'v4a_currency1', vai.currency1, 'v4a_fee', vai.fee,
                'v4a_tick_spacing', vai.tick_spacing, 'v4a_hooks', vai.hooks,
                'v4a_token', vai.token, 'v4a_token_decimals', vai.token_decimals,
                'v4a_stage', vai.stage, 'v4a_spender', vai.spender,
                'v4a_amount', vai.amount, 'v4a_expiration', vai.expiration,
                'v4a_target', vai.target, 'v4a_calldata', vai.calldata) AS v4_approval_json,
              json_object('v4s_pool_id', vsi.pool_id, 'v4s_currency0', vsi.currency0,
                'v4s_currency1', vsi.currency1, 'v4s_fee', vsi.fee,
                'v4s_tick_spacing', vsi.tick_spacing, 'v4s_hooks', vsi.hooks,
                'v4s_token_in', vsi.token_in, 'v4s_amount_in', vsi.amount_in,
                'v4s_amount_out_minimum', vsi.amount_out_minimum, 'v4s_deadline', vsi.deadline,
                'v4s_calldata', vsi.calldata, 'v4s_native_value', vsi.native_value) AS v4_swap_json,
              json_object('v4pa_action', vpa.action, 'v4pa_pool_id', vpa.pool_id,
                'v4pa_token_id', vpa.token_id, 'v4pa_tick_lower', vpa.tick_lower,
                'v4pa_tick_upper', vpa.tick_upper, 'v4pa_liquidity', vpa.liquidity,
                'v4pa_token_decimals', vpa.token_decimals, 'v4pa_slippage_bps', vpa.slippage_bps,
                'v4pa_deadline', vpa.deadline, 'v4pa_recipient', vpa.recipient,
                'v4pa_calldata', vpa.calldata) AS v4_position_action_json,
              pai.chain_id AS action_chain_id,
              pai.position_manager AS action_target,
              pai.calldata AS action_calldata,
              pai.token_id AS action_token_id,
              pai.constraints_json
              ,uwi.chain_id AS withdrawal_chain_id,
              uwi.calldata AS withdrawal_calldata,
              uwi.recipient AS withdrawal_recipient,
              uwi.amount AS withdrawal_amount,
              uwi.owner_address AS withdrawal_owner_address,
              uwi.owner_signature AS withdrawal_owner_signature,
              uwi.nonce AS withdrawal_nonce,
              uwi.signature_expires_at AS withdrawal_expires_at,
              si.chain_id AS swap_chain_id,
              si.calldata AS swap_calldata,
              si.pool_address AS swap_pool_address,
              si.token_address AS swap_token_address,
              si.token_decimals AS swap_token_decimals,
              si.fee AS swap_fee,
              si.token_in AS swap_token_in,
              si.token_out AS swap_token_out,
              si.recipient AS swap_recipient,
              si.amount_in AS swap_amount_in,
              si.amount_out_minimum AS swap_amount_out_minimum,
              si.deadline AS swap_deadline,
              json_object('run_id', wi.automation_run_id, 'run_status', ar.status,
                'mandate_id', am.id, 'mandate_status', am.status, 'mandate_pool_id', am.pool_id,
                'mandate_max_position_usd', am.max_position_usd,
                'mandate_max_runs_per_day', am.max_runs_per_day) AS automation_json
       FROM wallet_intents wi
       JOIN managed_wallets mw ON mw.id = wi.wallet_id
       JOIN users u ON u.id = mw.user_id
       LEFT JOIN approval_intents ai ON ai.intent_id = wi.id
       LEFT JOIN mint_intents mi ON mi.intent_id = wi.id
       LEFT JOIN v4_mint_intents vmi ON vmi.intent_id = wi.id
       LEFT JOIN v4_approval_intents vai ON vai.intent_id = wi.id
       LEFT JOIN v4_swap_intents vsi ON vsi.intent_id = wi.id
       LEFT JOIN v4_position_action_intents vpa ON vpa.intent_id = wi.id
       LEFT JOIN position_action_intents pai ON pai.intent_id = wi.id
       LEFT JOIN usdc_withdrawal_intents uwi ON uwi.intent_id = wi.id
       LEFT JOIN swap_intents si ON si.intent_id = wi.id
       LEFT JOIN automation_runs ar ON ar.id = wi.automation_run_id
       LEFT JOIN automation_mandates am ON am.id = ar.mandate_id
       WHERE wi.id = ?1`,
    ).bind(intentId).first<Row>();
    if (!row || !allowedKinds.has(row.kind)) return null;
    Object.assign(row, JSON.parse(row.v4_mint_json), JSON.parse(row.v4_approval_json),
      JSON.parse(row.v4_swap_json), JSON.parse(row.v4_position_action_json));

    const chainId = row.approval_chain_id ?? row.mint_chain_id ?? (row.v4_pool_id || row.v4a_pool_id || row.v4s_pool_id || row.v4pa_pool_id ? 5042 : null) ?? row.action_chain_id ??
      row.withdrawal_chain_id ?? row.swap_chain_id;
    const target = row.approval_target ?? row.mint_target ?? row.v4a_target ?? (row.v4_pool_id ? UNISWAP_V4_ARC.positionManager : null) ??
      (row.v4s_pool_id ? UNISWAP_SHARED_ARC.universalRouter.address : null) ??
      (row.v4pa_pool_id ? UNISWAP_V4_ARC.positionManager : null) ?? row.action_target ??
      (row.withdrawal_chain_id === null ? null : "0x3600000000000000000000000000000000000000") ??
      (row.swap_chain_id === null ? null : "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77");
    const data = row.approval_calldata ?? row.mint_calldata ?? row.v4_calldata ?? row.v4a_calldata ?? row.v4s_calldata ?? row.v4pa_calldata ?? row.action_calldata ??
      row.withdrawal_calldata ?? row.swap_calldata;
    if (chainId === null || target === null || data === null) return null;
    let expectedCirBtc: bigint | undefined;
    let expectedUsdc: bigint | undefined;
    if (row.constraints_json) {
      const constraints = JSON.parse(row.constraints_json) as Record<string, unknown>;
      if (typeof constraints.expectedCirBtc === "string") {
        expectedCirBtc = BigInt(constraints.expectedCirBtc);
      }
      if (typeof constraints.expectedUsdc === "string") {
        expectedUsdc = BigInt(constraints.expectedUsdc);
      }
    }
    const approvalPool = row.approval_target && row.approval_pool_address
      ? {
          tokenAddress: getAddress(row.approval_target),
          poolAddress: getAddress(row.approval_pool_address),
          poolTokenAddress: getAddress(row.approval_pool_token_address ?? row.approval_target),
          ...(row.approval_token_decimals === null ? {} : { tokenDecimals: row.approval_token_decimals }),
        }
      : undefined;
    const automation = await this.loadAutomation(JSON.parse(row.automation_json) as AutomationRow);
    const mintPool = row.mint_pool_address && row.mint_token0_address && row.mint_token1_address &&
      row.mint_fee !== null && row.mint_tick_spacing !== null
      ? {
          poolAddress: getAddress(row.mint_pool_address),
          token0: getAddress(row.mint_token0_address),
          token1: getAddress(row.mint_token1_address),
          fee: row.mint_fee,
          tickSpacing: row.mint_tick_spacing,
          ...(row.mint_token_decimals === null ? {} : { tokenDecimals: row.mint_token_decimals }),
        }
      : undefined;
    return {
      intentId: row.intent_id,
      kind: row.kind,
      status: row.status,
      expiresAt: row.expires_at,
      payloadHash: row.payload_hash,
      wallet: { address: getAddress(row.wallet_address), state: row.wallet_state },
      transaction: {
        chainId,
        to: getAddress(target),
        data,
        value: row.v4_native_value !== null ? BigInt(row.v4_native_value) :
          row.v4s_native_value !== null ? BigInt(row.v4s_native_value) : 0n,
      },
      approvalPool,
      mintPool,
      v4Mint: row.v4_pool_id && row.v4_currency0 && row.v4_currency1 &&
        row.v4_fee !== null && row.v4_tick_spacing !== null && row.v4_hooks &&
        row.v4_token_decimals !== null && row.v4_sqrt_price_x96 &&
        row.v4_tick !== null && row.v4_liquidity && row.v4_lp_fee !== null &&
        row.v4_recipient && row.v4_tick_lower !== null && row.v4_tick_upper !== null &&
        row.v4_amount0_desired && row.v4_amount1_desired && row.v4_slippage_bps !== null &&
        row.v4_deadline
        ? { pool: { id: row.v4_pool_id, currency0: getAddress(row.v4_currency0),
            currency1: getAddress(row.v4_currency1), fee: row.v4_fee,
            tickSpacing: row.v4_tick_spacing, hooks: getAddress(row.v4_hooks),
            sqrtPriceX96: row.v4_sqrt_price_x96, tick: row.v4_tick,
            liquidity: row.v4_liquidity, lpFee: row.v4_lp_fee },
          tokenDecimals: row.v4_token_decimals, recipient: getAddress(row.v4_recipient),
          tickLower: row.v4_tick_lower, tickUpper: row.v4_tick_upper,
          amount0Desired: BigInt(row.v4_amount0_desired), amount1Desired: BigInt(row.v4_amount1_desired),
          slippageBps: row.v4_slippage_bps, deadline: BigInt(row.v4_deadline) }
        : undefined,
      v4Approval: row.v4a_pool_id && row.v4a_currency0 && row.v4a_currency1 &&
        row.v4a_fee !== null && row.v4a_tick_spacing !== null && row.v4a_hooks &&
        row.v4a_token && row.v4a_token_decimals !== null && row.v4a_stage &&
        row.v4a_amount && row.v4a_expiration && row.v4a_spender
        ? { pool: { id: row.v4a_pool_id, currency0: getAddress(row.v4a_currency0),
            currency1: getAddress(row.v4a_currency1), fee: row.v4a_fee,
            tickSpacing: row.v4a_tick_spacing, hooks: getAddress(row.v4a_hooks),
            sqrtPriceX96: "0", tick: 0, liquidity: "0", lpFee: 0 },
          token: getAddress(row.v4a_token), tokenDecimals: row.v4a_token_decimals,
          stage: row.v4a_stage, amount: BigInt(row.v4a_amount),
          expiration: BigInt(row.v4a_expiration), spender: getAddress(row.v4a_spender) }
        : undefined,
      v4Swap: row.v4s_pool_id && row.v4s_currency0 && row.v4s_currency1 &&
        row.v4s_fee !== null && row.v4s_tick_spacing !== null && row.v4s_hooks &&
        row.v4s_token_in && row.v4s_amount_in && row.v4s_amount_out_minimum && row.v4s_deadline
        ? { pool: { id: row.v4s_pool_id, currency0: getAddress(row.v4s_currency0),
            currency1: getAddress(row.v4s_currency1), fee: row.v4s_fee,
            tickSpacing: row.v4s_tick_spacing, hooks: getAddress(row.v4s_hooks),
            sqrtPriceX96: "0", tick: 0, liquidity: "0", lpFee: 0 },
          tokenIn: getAddress(row.v4s_token_in), amountIn: BigInt(row.v4s_amount_in),
          amountOutMinimum: BigInt(row.v4s_amount_out_minimum), deadline: BigInt(row.v4s_deadline) }
        : undefined,
      v4PositionAction: row.v4pa_action && row.v4pa_pool_id && row.v4pa_token_id &&
        row.v4pa_tick_lower !== null && row.v4pa_tick_upper !== null &&
        row.v4pa_liquidity && row.v4pa_token_decimals !== null &&
        row.v4pa_slippage_bps !== null && row.v4pa_deadline && row.v4pa_recipient
        ? { kind: row.v4pa_action, poolId: row.v4pa_pool_id,
          tokenId: BigInt(row.v4pa_token_id), tickLower: row.v4pa_tick_lower,
          tickUpper: row.v4pa_tick_upper, liquidity: BigInt(row.v4pa_liquidity),
          tokenDecimals: row.v4pa_token_decimals, slippageBps: row.v4pa_slippage_bps,
          deadline: BigInt(row.v4pa_deadline), recipient: getAddress(row.v4pa_recipient) }
        : undefined,
      tokenId: row.action_token_id === null ? undefined : BigInt(row.action_token_id),
      expectedCirBtc,
      expectedUsdc,
      withdrawal: row.withdrawal_recipient && row.withdrawal_amount &&
        row.withdrawal_owner_address && row.withdrawal_owner_signature &&
        row.withdrawal_nonce && row.withdrawal_expires_at
        ? {
            transaction: buildUsdcWithdrawal({
              wallet: getAddress(row.wallet_address),
              recipient: getAddress(row.withdrawal_recipient),
              amount: BigInt(row.withdrawal_amount),
              nonce: row.withdrawal_nonce,
              expiresAt: BigInt(row.withdrawal_expires_at),
            }),
            ownerAddress: getAddress(row.root_owner_address),
            signature: row.withdrawal_owner_signature,
          }
        : undefined,
      swap: row.swap_pool_address && row.swap_token_address &&
        row.swap_token_decimals !== null && row.swap_fee !== null &&
        row.swap_token_in && row.swap_token_out && row.swap_recipient &&
        row.swap_amount_in && row.swap_amount_out_minimum && row.swap_deadline
        ? {
            transaction: buildSwap({
              poolAddress: getAddress(row.swap_pool_address),
              poolFee: row.swap_fee,
              tokenIn: getAddress(row.swap_token_in),
              tokenOut: getAddress(row.swap_token_out),
              recipient: getAddress(row.swap_recipient),
              amountIn: BigInt(row.swap_amount_in),
              amountOutMinimum: BigInt(row.swap_amount_out_minimum),
              deadline: BigInt(row.swap_deadline),
            }),
            tokenAddress: getAddress(row.swap_token_address),
            tokenDecimals: row.swap_token_decimals,
          }
        : undefined,
      custody: row.circle_wallet_id
        ? {
            walletId: row.wallet_id,
            circleWalletId: row.circle_wallet_id,
            address: getAddress(row.wallet_address),
          }
        : undefined,
      automation,
    };
  }

  /** The run and mandate behind an agent's request; undefined when the user made it. */
  private async loadAutomation(row: AutomationRow): Promise<LoadedMainnetIntent["automation"]> {
    if (row.run_id === null) return undefined;
    const mandate = row.mandate_id !== null && row.mandate_status !== null && row.mandate_pool_id !== null &&
      row.mandate_max_position_usd !== null && row.mandate_max_runs_per_day !== null
      ? { status: row.mandate_status, poolId: row.mandate_pool_id,
          maxPositionUsd: row.mandate_max_position_usd, maxRunsPerDay: row.mandate_max_runs_per_day }
      : null;
    const started = mandate === null ? null : await this.db.prepare(
      "SELECT COUNT(*) AS runs FROM automation_runs WHERE mandate_id = ?1 AND started_at >= ?2",
    ).bind(row.mandate_id, Date.now() - DAY_MS).first<{ runs: number }>();
    return { runId: row.run_id, runStatus: row.run_status, mandate, runsStartedToday: started?.runs ?? 0 };
  }

  async save(value: MainnetEvaluation): Promise<void> {
    await this.db.prepare(
      `INSERT INTO mainnet_policy_evaluations (
        id, intent_id, decision, reason_code, block_number, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      `evaluation_${crypto.randomUUID()}`,
      value.intentId,
      value.decision,
      value.reasonCode,
      value.blockNumber,
      value.createdAt,
    ).run();
  }
}
