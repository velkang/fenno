-- Withdrawals of any token, not only USDC, share the USDC withdrawal table: token_address is
-- empty for USDC and holds the token for the others (intent kind token_withdrawal). The table
-- keeps its name so a signer still running the previous build keeps working during a deploy.
ALTER TABLE usdc_withdrawal_intents ADD COLUMN token_address TEXT COLLATE NOCASE;
