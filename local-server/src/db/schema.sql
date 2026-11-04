-- Phase 1 local-server schema (test data only). Non-destructive migrations apply on top.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  station_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS printers (
  printer_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  connection_type TEXT NOT NULL CHECK (
    connection_type IN ('MOCK', 'NETWORK_TCP', 'WINDOWS_SPOOLER')
  ),
  host TEXT,
  port INTEGER,
  windows_queue_name TEXT,
  paper_width_mm INTEGER NOT NULL DEFAULT 80,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_test_status TEXT,
  last_test_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station_printers (
  station_id TEXT NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
  printer_id TEXT NOT NULL REFERENCES printers(printer_id) ON DELETE CASCADE,
  PRIMARY KEY (station_id, printer_id)
);

CREATE TABLE IF NOT EXISTS menu_items (
  item_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_stations (
  item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
  station_id TEXT NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, station_id)
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  order_type TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, order_number)
);

CREATE TABLE IF NOT EXISTS order_lines (
  line_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES menu_items(item_id),
  item_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  station_id TEXT REFERENCES stations(station_id),
  line_index INTEGER NOT NULL,
  UNIQUE (order_id, line_index)
);

CREATE TABLE IF NOT EXISTS order_line_instructions (
  instruction_id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES order_lines(line_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS print_jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  station_id TEXT,
  printer_id TEXT NOT NULL REFERENCES printers(printer_id),
  ticket_revision INTEGER NOT NULL DEFAULT 1,
  job_type TEXT NOT NULL CHECK (job_type IN ('KITCHEN', 'CASHIER')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'DISPATCHING',
      'DISPATCHED',
      'FAILED',
      'UNKNOWN',
      'NEEDS_REVIEW',
      'CONFIRMED'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  is_reprint INTEGER NOT NULL DEFAULT 0 CHECK (is_reprint IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS print_job_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES print_jobs(job_id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  api_token_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
