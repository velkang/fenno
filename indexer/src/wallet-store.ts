import { getAddress } from "viem";
import { ALPHA_POOL } from "@stillwater/chain";
import type {
  ManagedWallet,
  PositionSnapshot,
  WalletIndexerStore,
  WalletReconciliation,
  WalletSnapshot,
} from "./wallet-indexer";

export class D1WalletIndexerStore implements WalletIndexerStore {
  constructor(private readonly db: D1Database) {}

  async listManagedWallets(limit: number): Promise<ManagedWallet[]> {
    // Least recently indexed first, so every wallet is reached across runs.
    const result = await this.db
      .prepare(
        `SELECT id, address FROM managed_wallets
         WHERE state IN ('active', 'paused')
         ORDER BY (
           SELECT MAX(block_number) FROM managed_wallet_snapshots s
           WHERE s.wallet_id = managed_wallets.id
         ) NULLS FIRST, id
         LIMIT ?1`,
      )
      .bind(limit)
      .all<{ id: string; address: string }>();
    return result.results.map((row) => ({
      id: row.id,
      address: getAddress(row.address),
    }));
  }

  async saveSnapshot(snapshot: WalletSnapshot): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO managed_wallet_snapshots (
            wallet_id, chain_id, block_number, block_hash, address, native_usdc,
            usdc, cirbtc, position_manager_usdc_allowance,
            position_manager_cirbtc_allowance, permit2_usdc_allowance,
            permit2_cirbtc_allowance, observed_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          snapshot.walletId,
          snapshot.chainId,
          snapshot.blockNumber,
          snapshot.blockHash,
          snapshot.address,
          snapshot.nativeUsdc,
          snapshot.usdc,
          snapshot.cirBtc,
          snapshot.positionManagerUsdcAllowance,
          snapshot.positionManagerCirBtcAllowance,
          snapshot.permit2UsdcAllowance,
          snapshot.permit2CirBtcAllowance,
          snapshot.observedAt,
        ),
      // One statement for all positions: each D1 statement counts toward the
      // free plan's 50 queries per invocation.
      ...(snapshot.positions.length === 0 ? [] : [
        this.db
          .prepare(
            `INSERT OR IGNORE INTO uniswap_position_snapshots (
              wallet_id, token_id, chain_id, block_number, pool_address,
              tick_lower, tick_upper, liquidity, recorded_owed0, recorded_owed1,
              claimable0, claimable1
            )
            SELECT ?1, value ->> '$.tokenId', ?2, ?3, ?4,
              value ->> '$.tickLower', value ->> '$.tickUpper', value ->> '$.liquidity',
              value ->> '$.recordedOwed0', value ->> '$.recordedOwed1',
              value ->> '$.claimable0', value ->> '$.claimable1'
            FROM json_each(?5)`,
          )
          .bind(
            snapshot.walletId,
            snapshot.chainId,
            snapshot.blockNumber,
            ALPHA_POOL.address,
            JSON.stringify(snapshot.positions),
          ),
      ]),
    ];
    await this.db.batch(statements);
  }

  async getSnapshot(input: {
    walletId: string;
    chainId: number;
    blockNumber: number;
  }): Promise<WalletSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM managed_wallet_snapshots
         WHERE wallet_id = ?1 AND chain_id = ?2 AND block_number = ?3`,
      )
      .bind(input.walletId, input.chainId, input.blockNumber)
      .first<Record<string, string | number>>();
    if (!row) return null;
    const positionRows = await this.db
      .prepare(
        `SELECT token_id, tick_lower, tick_upper, liquidity, recorded_owed0,
                recorded_owed1, claimable0, claimable1
         FROM uniswap_position_snapshots
         WHERE wallet_id = ?1 AND chain_id = ?2 AND block_number = ?3`,
      )
      .bind(input.walletId, input.chainId, input.blockNumber)
      .all<Record<string, string | number>>();
    const positions: PositionSnapshot[] = positionRows.results.map((position) => ({
      tokenId: String(position.token_id),
      tickLower: Number(position.tick_lower),
      tickUpper: Number(position.tick_upper),
      liquidity: String(position.liquidity),
      recordedOwed0: String(position.recorded_owed0),
      recordedOwed1: String(position.recorded_owed1),
      claimable0: String(position.claimable0),
      claimable1: String(position.claimable1),
    }));
    return {
      walletId: String(row.wallet_id),
      chainId: Number(row.chain_id),
      blockNumber: Number(row.block_number),
      blockHash: String(row.block_hash) as `0x${string}`,
      address: getAddress(String(row.address)),
      nativeUsdc: String(row.native_usdc),
      usdc: String(row.usdc),
      cirBtc: String(row.cirbtc),
      positionManagerUsdcAllowance: String(row.position_manager_usdc_allowance),
      positionManagerCirBtcAllowance: String(row.position_manager_cirbtc_allowance),
      permit2UsdcAllowance: String(row.permit2_usdc_allowance),
      permit2CirBtcAllowance: String(row.permit2_cirbtc_allowance),
      positions,
      observedAt: Number(row.observed_at),
    };
  }

  async saveReconciliation(value: WalletReconciliation): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO wallet_reconciliations (
          wallet_id, chain_id, block_number, status, mismatch_fields, checked_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(wallet_id, chain_id, block_number) DO UPDATE SET
          status = excluded.status,
          mismatch_fields = excluded.mismatch_fields,
          checked_at = excluded.checked_at`,
      )
      .bind(
        value.walletId,
        value.chainId,
        value.blockNumber,
        value.status,
        value.mismatchFields.length ? JSON.stringify(value.mismatchFields) : null,
        value.checkedAt,
      )
      .run();
  }
}
