-- Phase 1.3: Menu Setup fields (non-destructive). Preserves existing item_id / sku rows.

ALTER TABLE menu_items ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN subcategory TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE menu_items ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0);
ALTER TABLE menu_items ADD COLUMN code TEXT;
ALTER TABLE menu_items ADD COLUMN image_filename TEXT;
ALTER TABLE menu_items ADD COLUMN is_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (is_sold_out IN (0, 1));
ALTER TABLE menu_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN instruction_modifiers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE menu_items ADD COLUMN instruction_targets_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category);
CREATE INDEX IF NOT EXISTS idx_menu_items_sort ON menu_items(sort_order, name);

-- Backfill categories / display prices for known Phase 1 seed items (IDs preserved).
UPDATE menu_items
SET category = 'Drinks',
    subcategory = 'Juice',
    price_cents = 800,
    code = 'OJ',
    sort_order = 10,
    description = 'Fresh orange juice',
    instruction_modifiers_json = '["Less","More","No","Extra"]',
    instruction_targets_json = '["Sugar","Ice","Milk"]'
WHERE item_id = 'item_orange_juice';

UPDATE menu_items
SET category = 'Shawarma',
    subcategory = '',
    price_cents = 1500,
    code = 'CS',
    sort_order = 20,
    description = 'Chicken shawarma wrap',
    instruction_modifiers_json = '["Less","More","No","Extra"]',
    instruction_targets_json = '["Sauce","Onion","Salt","Cheese"]'
WHERE item_id = 'item_chicken_shawarma';

UPDATE menu_items
SET category = 'Grill',
    subcategory = 'Burgers',
    price_cents = 1800,
    code = 'CB',
    sort_order = 30,
    description = 'Chicken burger',
    instruction_modifiers_json = '["Less","More","No","Extra"]',
    instruction_targets_json = '["Sauce","Onion","Salt","Cheese"]'
WHERE item_id = 'item_chicken_burger';
