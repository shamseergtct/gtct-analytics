/**
 * Step 1 — staff identity foundation only.
 * No accounts, passwords, or sessions are created.
 * Existing authentication is unchanged.
 */

const PERMISSIONS = [
  ["sales.order.create", "Create sales orders"],
  ["customers.manage", "Create and edit customers and addresses"],
  ["sales.delivery_fee.edit", "Edit the delivery charge on the current order"],
  ["menu.manage", "Manage menu items, categories, variants, and add-ons"],
  ["shop.settings.manage", "Manage shop settings"],
  ["printers.manage", "Manage printers and stations"],
  ["print.reprint_confirm", "Reprint and confirm print jobs"],
  ["audit.view", "View the audit log"],
  ["sales.price_override", "Override an order-line selling price"],
  ["sales.addon_price_override", "Override a configured add-on price on an order"],
  ["menu.sold_out.update", "Update sold-out status"],
];

const ROLES = [
  ["role_admin", "admin", "Admin"],
  ["role_cashier", "cashier", "Cashier"],
];

/** Cashier matches today's device abilities. Price overrides stay off. */
const CASHIER_PERMISSIONS = new Set([
  "sales.order.create",
  "customers.manage",
  "sales.delivery_fee.edit",
  "menu.sold_out.update",
]);

export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_users (
        user_id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        password_hash TEXT NOT NULL CHECK (length(password_hash) >= 32),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, shop_id),
        UNIQUE (shop_id, username_normalized),
        FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id)
      );

      CREATE TABLE IF NOT EXISTS staff_roles (
        role_id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS staff_permissions (
        permission_code TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS staff_role_permissions (
        role_id TEXT NOT NULL,
        permission_code TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (role_id, permission_code),
        FOREIGN KEY (role_id) REFERENCES staff_roles(role_id),
        FOREIGN KEY (permission_code) REFERENCES staff_permissions(permission_code)
      );

      CREATE TABLE IF NOT EXISTS staff_user_roles (
        shop_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (shop_id, user_id, role_id),
        FOREIGN KEY (user_id, shop_id) REFERENCES staff_users(user_id, shop_id),
        FOREIGN KEY (role_id) REFERENCES staff_roles(role_id),
        FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id)
      );

      CREATE TABLE IF NOT EXISTS staff_user_permissions (
        shop_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        permission_code TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (shop_id, user_id, permission_code),
        FOREIGN KEY (user_id, shop_id) REFERENCES staff_users(user_id, shop_id),
        FOREIGN KEY (permission_code) REFERENCES staff_permissions(permission_code),
        FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id)
      );

      CREATE TABLE IF NOT EXISTS staff_sessions (
        session_id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) >= 32),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (user_id, shop_id) REFERENCES staff_users(user_id, shop_id),
        FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id)
      );

      CREATE INDEX IF NOT EXISTS idx_staff_users_shop
        ON staff_users (shop_id);
      CREATE INDEX IF NOT EXISTS idx_staff_user_roles_shop
        ON staff_user_roles (shop_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_staff_sessions_user
        ON staff_sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_staff_sessions_expiry
        ON staff_sessions (absolute_expires_at, idle_expires_at);
    `);

    const now = new Date().toISOString();
    const insertPermission = db.prepare(
      `INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
       VALUES (?, ?, ?)`
    );
    for (const [code, description] of PERMISSIONS) {
      insertPermission.run(code, description, now);
    }

    const insertRole = db.prepare(
      `INSERT OR IGNORE INTO staff_roles (role_id, code, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const [roleId, code, name] of ROLES) {
      insertRole.run(roleId, code, name, now, now);
    }

    const insertGrant = db.prepare(
      `INSERT OR IGNORE INTO staff_role_permissions
         (role_id, permission_code, granted_at, revoked_at)
       VALUES (?, ?, ?, NULL)`
    );
    for (const [code] of PERMISSIONS) {
      insertGrant.run("role_admin", code, now);
      if (CASHIER_PERMISSIONS.has(code)) {
        insertGrant.run("role_cashier", code, now);
      }
    }
  });
  tx();
}
