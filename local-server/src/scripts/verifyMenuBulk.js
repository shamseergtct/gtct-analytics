import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations, closeDatabase } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import {
  exportMenuItemsCsv,
  importMenuItemsCsv,
} from "../services/menuBulk.js";
import { listMenuItems, getMenuItem } from "../services/menuMappings.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-menu-bulk-"));
const dbPath = path.join(dir, "test.sqlite");
const db = openDatabase(dbPath);
await runMigrations(db);
seedSampleData({ dataDir: dir, dbPath, operatingMode: "TEST" });

const csv1 = exportMenuItemsCsv();
if (!csv1.includes("item_id,name,category,subcategory,variant,price,preparation_center")) {
  throw new Error("missing header");
}
console.log("export rows", csv1.trim().split("\n").length - 1);

const before = listMenuItems().length;
const createCsv = `item_id,name,category,subcategory,variant,price,preparation_center
,Bulk Tea,Beverages,,,4.50,JUICE
,Bulk Pizza,Food,Pizza,Small,20.00,GRILL
,Bulk Pizza,Food,Pizza,Large,35.00,GRILL
`;
const summary = importMenuItemsCsv(createCsv);
console.log("create summary", summary);
if (summary.created !== 2) throw new Error(`expected 2 created, got ${summary.created}`);
if (summary.errors.length) throw new Error(summary.errors.join("; "));

const tea = listMenuItems().find((i) => i.name === "Bulk Tea");
const pizza = listMenuItems().find((i) => i.name === "Bulk Pizza");
if (!tea || tea.hasVariants) throw new Error("tea should be plain");
if (!pizza?.hasVariants || pizza.variants.filter((v) => v.isActive).length !== 2) {
  throw new Error("pizza variants missing");
}

const editCsv = `item_id,name,category,subcategory,variant,price,preparation_center
${tea.item_id},Bulk Tea Edited,Beverages,,,5.25,JUICE
${pizza.item_id},Bulk Pizza,Food,Pizza,Small,22.00,GRILL
${pizza.item_id},Bulk Pizza,Food,Pizza,Large,40.00,GRILL
`;
const updated = importMenuItemsCsv(editCsv);
console.log("update summary", updated);
if (updated.updated !== 2) throw new Error(`expected 2 updated, got ${updated.updated}`);

const tea2 = getMenuItem(tea.item_id);
if (tea2.name !== "Bulk Tea Edited" || tea2.price_cents !== 525) {
  throw new Error(`tea edit failed: ${tea2.name} ${tea2.price_cents}`);
}
const pizza2 = getMenuItem(pizza.item_id);
const large = pizza2.variants.find((v) => v.name === "Large" && v.isActive);
if (!large || large.priceCents !== 4000) throw new Error("pizza large price not updated");

console.log("OK before=", before, "after=", listMenuItems().length);
closeDatabase();
fs.rmSync(dir, { recursive: true, force: true });
