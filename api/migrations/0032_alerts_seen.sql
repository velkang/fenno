-- When the wallet's user last opened Tomo's alerts; newer alerts show the bell's dot on every device.
ALTER TABLE managed_wallets ADD COLUMN alerts_seen_at INTEGER;
