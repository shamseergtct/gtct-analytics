/** TEST only: immutable rider commission configuration history. No expense posting. */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_commission_policies (
      policy_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      rider_user_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      effective_business_date TEXT NOT NULL CHECK(effective_business_date GLOB '????-??-??'),
      currency_code TEXT NOT NULL CHECK(length(currency_code) = 3),
      currency_decimals INTEGER NOT NULL CHECK(currency_decimals BETWEEN 0 AND 4),
      policy_json TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      submission_fingerprint TEXT NOT NULL CHECK(length(submission_fingerprint) = 64),
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(shop_id,rider_user_id,version),
      UNIQUE(shop_id,submission_id),
      FOREIGN KEY(rider_user_id,shop_id) REFERENCES staff_users(user_id,shop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_commission_policy_effective
      ON delivery_commission_policies(shop_id,rider_user_id,effective_business_date DESC,version DESC);
  `);
}
