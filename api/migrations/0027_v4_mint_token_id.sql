-- The position NFT a confirmed v4 mint gave the wallet, recorded once so listing positions
-- does not depend on reading old receipts the RPC may have pruned. NULL until known.
ALTER TABLE v4_mint_intents ADD COLUMN token_id TEXT;
