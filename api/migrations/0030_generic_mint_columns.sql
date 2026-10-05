-- The mint amount columns were named for the first pool, cirBTC/USDC. They hold the pool's
-- token0 and token1 amounts, whichever tokens those are.
ALTER TABLE mint_intents RENAME COLUMN amount_cirbtc_desired TO amount0_desired;
ALTER TABLE mint_intents RENAME COLUMN amount_usdc_desired TO amount1_desired;
ALTER TABLE mint_intents RENAME COLUMN amount_cirbtc_min TO amount0_min;
ALTER TABLE mint_intents RENAME COLUMN amount_usdc_min TO amount1_min;
ALTER TABLE mint_intents RENAME COLUMN simulated_amount_cirbtc TO simulated_amount0;
ALTER TABLE mint_intents RENAME COLUMN simulated_amount_usdc TO simulated_amount1;

-- Positions are listed from the pools a wallet opened through Stillwater; nothing imports
-- positions any more.
DROP TABLE IF EXISTS position_imports;
