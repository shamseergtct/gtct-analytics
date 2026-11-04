-- Phase 1.4: Shop display settings (currency + kitchen note defaults).
-- Non-destructive. Does not alter menu_items.price_cents values.

CREATE TABLE IF NOT EXISTS shop_settings (
  shop_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'GTCT Restaurant',
  currency_code TEXT NOT NULL DEFAULT 'QAR',
  currency_label TEXT NOT NULL DEFAULT 'QR',
  currency_decimals INTEGER NOT NULL DEFAULT 2 CHECK (currency_decimals BETWEEN 0 AND 4),
  instruction_modifiers_json TEXT NOT NULL DEFAULT '["Less","More","No","Extra"]',
  instruction_targets_json TEXT NOT NULL DEFAULT '["Sugar","Sauce","Onion","Salt","Ice","Cheese"]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO shop_settings (
  shop_id, display_name, currency_code, currency_label, currency_decimals,
  instruction_modifiers_json, instruction_targets_json, created_at, updated_at
) VALUES (
  'test-tenant-phase1',
  'GTCT Restaurant',
  'QAR',
  'QR',
  2,
  '["Less","More","No","Extra"]',
  '["Sugar","Sauce","Onion","Salt","Ice","Cheese"]',
  datetime('now'),
  datetime('now')
);
