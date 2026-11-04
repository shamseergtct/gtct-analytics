import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";
import { upsertPrinter } from "../services/printers.js";
import { upsertStation } from "../services/stations.js";
import { upsertMenuItem } from "../services/menuMappings.js";
import { log } from "../util/logger.js";

/**
 * Seed default stations, MOCK printers, and synthetic menu mappings.
 * Never resets existing data.
 */
export function seedIfEmpty(config) {
  const db = getDb();
  const stationCount = db.prepare(`SELECT COUNT(*) AS c FROM stations`).get().c;
  if (stationCount > 0) {
    log.info("Seed skipped — stations already present");
    return { seeded: false };
  }
  return seedSampleData(config);
}

export function seedSampleData(config) {
  const ts = nowIso();
  const db = getDb();

  const printers = [
    {
      printerId: "prn_mock_juice",
      displayName: "Mock Juice Printer",
      connectionType: "MOCK",
      paperWidthMm: 80,
    },
    {
      printerId: "prn_mock_shawarma",
      displayName: "Mock Shawarma Printer",
      connectionType: "MOCK",
      paperWidthMm: 80,
    },
    {
      printerId: "prn_mock_grill",
      displayName: "Mock Grill Printer",
      connectionType: "MOCK",
      paperWidthMm: 80,
    },
    {
      printerId: "prn_mock_cashier",
      displayName: "Mock Cashier Printer",
      connectionType: "MOCK",
      paperWidthMm: 80,
    },
  ];

  for (const p of printers) {
    upsertPrinter(p);
  }

  const stations = [
    {
      stationId: "station_juice",
      name: "JUICE",
      description: "Juice and cold drinks prep",
      printerId: "prn_mock_juice",
    },
    {
      stationId: "station_shawarma",
      name: "SHAWARMA",
      description: "Shawarma station",
      printerId: "prn_mock_shawarma",
    },
    {
      stationId: "station_grill",
      name: "GRILL",
      description: "Grill / burger station",
      printerId: "prn_mock_grill",
    },
    {
      stationId: "station_cashier",
      name: "CASHIER",
      description: "Cashier receipt printer",
      printerId: "prn_mock_cashier",
    },
  ];

  for (const s of stations) {
    upsertStation(s);
  }

  const items = [
    {
      itemId: "item_orange_juice",
      sku: "TEST-OJ",
      name: "Orange Juice",
      category: "Beverages",
      subcategory: "Fresh Juice",
      description: "Fresh orange juice",
      priceCents: 800,
      code: "OJ",
      sortOrder: 10,
      stationIds: ["station_juice"],
      instructionModifiers: ["Less", "More", "No", "Extra"],
      instructionTargets: ["Sugar", "Ice", "Milk"],
    },
    {
      itemId: "item_chicken_shawarma",
      sku: "TEST-CS",
      name: "Chicken Shawarma",
      category: "Food",
      subcategory: "Shawarma",
      description: "Chicken shawarma wrap",
      priceCents: 1500,
      code: "CS",
      sortOrder: 20,
      stationIds: ["station_shawarma"],
      instructionModifiers: ["Less", "More", "No", "Extra"],
      instructionTargets: ["Sauce", "Onion", "Salt", "Cheese"],
    },
    {
      itemId: "item_chicken_burger",
      sku: "TEST-CB",
      name: "Chicken Burger",
      category: "Food",
      subcategory: "Burgers",
      description: "Chicken burger",
      priceCents: 1800,
      code: "CB",
      sortOrder: 30,
      stationIds: ["station_grill"],
      instructionModifiers: ["Less", "More", "No", "Extra"],
      instructionTargets: ["Sauce", "Onion", "Salt", "Cheese"],
    },
  ];

  for (const item of items) {
    upsertMenuItem(item);
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(
    "seed.phase1",
    JSON.stringify({
      at: ts,
      note: "Synthetic Phase 1 test data only",
      tenantId: config.testTenantId,
    })
  );

  log.info("Phase 1 sample data seeded", {
    printers: printers.length,
    stations: stations.length,
    menuItems: items.length,
  });

  return { seeded: true };
}
