/**
 * Delivery customers, unlisted blocks, and order-specific delivery fees.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, closeDatabase, runMigrations, getDb } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { initLogger, log } from "../util/logger.js";
import { getOrder } from "../services/orders.js";
import { mulDivRoundHalfUp } from "../services/tax.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function httpJson(port, method, pathName, token, body) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          Accept: "application/json",
          ...(token
            ? {
                Cookie: `gtct_ls_session=${encodeURIComponent(token)}`,
                Origin: `http://127.0.0.1:${port}`,
              }
            : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push({ name, ok: true });
    log.info(`PASS ${name}`);
  };
  const fail = (name, err) => {
    results.push({ name, ok: false, error: String(err?.message || err) });
    log.error(`FAIL ${name}`, { error: String(err?.message || err) });
  };

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
    const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
    assert(html.includes('id="customer-dialog"'), "add customer popup");
    assert(html.includes('id="cust-cancel"'), "cancel customer popup");
    assert(app.includes("Search customer name or phone"), "customer search");
    assert(app.includes("Customer already exists. Select existing customer."), "duplicate customer message");
    assert(html.includes('id="address-picker-dialog"'), "address picker");
    assert(app.includes("+ Add"), "add customer button");
    assert(app.includes("No saved rate for this block"), "unlisted block warning");
    assert(app.includes("selectCustomer"), "customer selection");
    const selectAt = app.indexOf("function selectCustomer");
    const clearAt = app.indexOf("function clearSelectedCustomer");
    assert(selectAt > 0 && clearAt > selectAt, "customer select helpers");
    assert(!app.slice(selectAt, clearAt).includes("emptyCart"), "selecting a customer keeps the cart");
    const closeAt = app.indexOf("function closeCustomerDialog");
    const openAt = app.indexOf("function openCustomerDialog");
    assert(closeAt > 0 && openAt > closeAt, "cancel helper");
    assert(!app.slice(closeAt, openAt).includes("/v1/customers"), "cancel does not save a customer");
    assert(css.includes("min-height: 8.5rem"), "cart items keep a scroll area");
    assert(!html.includes("Kitchen tickets"), "printer panel is not a permanent section");
    assert(html.includes('id="print-jobs-btn"'), "printer status button");
    assert(html.includes('id="print-jobs-drawer"'), "print jobs drawer");
    assert(app.includes("Not a physical print"), "mock tickets are not called physical prints");
    assert(app.includes("el.remove()"), "dismissing a notice does not call the print API");
    assert(css.includes("height: 100dvh"), "sales workspace uses the viewport height");
    assert(app.includes('placeholder: "Optional"') && app.includes("ff-vehicle"), "car hop vehicle stays optional");
    assert(app.includes("Customer (Optional)") && app.includes("Customer (Required)"), "customer label follows the order type");
    const renderAt = app.indexOf("function renderFulfillmentFields");
    const renderBody = app.slice(renderAt, renderAt + 1800);
    const pickerAt = renderBody.indexOf("customerPickerHtml");
    const counterAt = renderBody.indexOf('behavior === "COUNTER"');
    assert(pickerAt > 0 && counterAt > pickerAt, "customer search is shared by every order type");
    const typeChange = app.indexOf('$("order-type")?.addEventListener("change"');
    const typeBody = app.slice(typeChange, typeChange + 250);
    assert(typeChange > 0 && !typeBody.includes("emptyCart"), "changing order type keeps the cart");
    assert(!typeBody.includes("deliveryChargeCents = null"), "leaving delivery keeps the draft fee");
    pass("sales-markup");
  } catch (err) {
    fail("sales-markup", err);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-customers-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18826";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  const server = createServer(config);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;
  const shopId = config.testTenantId;

  try {
    const phoneCol = getDb()
      .prepare(`PRAGMA table_info(shop_customers)`)
      .all()
      .find((col) => col.name === "phone");
    assert(phoneCol?.type === "TEXT", "phone is stored as text");

    const anon = await httpJson(port, "POST", "/v1/customers", null, {
      name: "Nobody",
      phone: "33000000",
      blockNumber: "1",
    });
    assert(anon.status === 401, "anonymous customer create rejected");
    const anonSearch = await httpJson(port, "GET", "/v1/customers?q=Ali", null);
    assert(anonSearch.status === 401, "anonymous search rejected");

    const missingPhone = await httpJson(port, "POST", "/v1/customers", device, {
      name: "No Phone",
      phone: "",
      blockNumber: "1",
    });
    assert(missingPhone.status === 400, "contact number required");

    const ali = await httpJson(port, "POST", "/v1/customers", device, {
      name: "Ali Hassan",
      phone: "33111222",
      buildingNumber: "10",
      roadNumber: "20",
      blockNumber: "361",
      addressNote: "Blue gate",
    });
    assert(ali.status === 201, ali.json?.error || "create ali");
    const sara = await httpJson(port, "POST", "/v1/customers", device, {
      name: "Sara",
      phone: "03334444",
      blockNumber: "12",
    });
    assert(sara.status === 201, sara.json?.error || "create sara");
    assert(sara.json.customer.phone === "03334444", "leading zero preserved");

    const byName = await httpJson(port, "GET", "/v1/customers?q=has", device);
    assert(byName.status === 200, "name search");
    assert(byName.json.customers.some((row) => row.name === "Ali Hassan"), "partial name");
    assert(!byName.json.customers.some((row) => row.name === "Sara"), "name search is partial");
    const byPhone = await httpJson(port, "GET", "/v1/customers?q=0333", device);
    assert(byPhone.json.customers.some((row) => row.customerId === sara.json.customer.customerId), "partial phone");

    const dup = await httpJson(port, "POST", "/v1/customers", device, {
      name: "Ali Copy",
      phone: "3311-1222",
      blockNumber: "9",
    });
    assert(dup.status === 409 && dup.json.code === "CUSTOMER_PHONE_EXISTS", "duplicate phone");
    assert(dup.json.error === "Customer already exists. Select existing customer.", "duplicate message");
    assert(dup.json.customer.customerId === ali.json.customer.customerId, "duplicate offers the existing customer");
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM shop_customers WHERE shop_id = ?`).get(shopId).n;
    assert(count === 2, "duplicate request did not insert");

    const foreignShop = await httpJson(port, "POST", "/v1/customers", device, {
      shopId: "other-shop",
      name: "Other",
      phone: "33220011",
      blockNumber: "1",
    });
    assert(foreignShop.status === 403, "foreign shop rejected");

    const otherId = "cust_other_shop_person";
    getDb()
      .prepare(
        `INSERT INTO shop_customers (
          customer_id, shop_id, name, phone, phone_key,
          building_number, road_number, block_number, address_note, created_at, updated_at
        ) VALUES (?, 'other-shop', 'Ali Other', '33111222', '33111222', '', '', '1', '', ?, ?)`
      )
      .run(otherId, new Date().toISOString(), new Date().toISOString());
    const hidden = await httpJson(port, "GET", "/v1/customers?q=Ali", device);
    assert(!hidden.json.customers.some((row) => row.customerId === otherId), "search stays in this shop");
    const otherGet = await httpJson(port, "GET", `/v1/customers/${otherId}`, device);
    assert(otherGet.status === 404, "other shop customer is hidden");
    const bareId = "cust_no_phone";
    getDb()
      .prepare(
        `INSERT INTO shop_customers (
          customer_id, shop_id, name, phone, phone_key,
          building_number, road_number, block_number, address_note, created_at, updated_at
        ) VALUES (?, ?, 'No Contact', '', 'nocontact', '', '', '', '', ?, ?)`
      )
      .run(bareId, shopId, new Date().toISOString(), new Date().toISOString());

    const createAudits = getDb()
      .prepare(`SELECT detail_json FROM audit_events WHERE action = 'customer.create'`)
      .all();
    assert(createAudits.length >= 1, "customer create audited");
    assert(!createAudits.some((row) => row.detail_json.includes("33111222")), "audit omits the phone number");

    const currency = await httpJson(port, "PUT", "/v1/shop-settings", admin, {
      currencyCode: "BHD",
      currencyLabel: "BHD",
      currencyDecimals: 3,
      confirmCurrencyChange: true,
      taxEnabled: true,
      taxMode: "exclusive",
      taxRatePercent: "10",
      taxName: "VAT",
    });
    assert(currency.status === 200, currency.json?.error || "currency");
    await httpJson(port, "PUT", "/v1/block-delivery-rates", admin, {
      blockNumber: "361",
      chargeCents: 300,
      isActive: true,
    });
    const beforeRates = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM shop_block_delivery_rates WHERE shop_id = ?`)
      .get(shopId).n;

    const menu = await httpJson(port, "GET", "/v1/menu-items?includeInactive=0", device);
    const item = (menu.json.menuItems || []).find((row) => row.is_active);
    assert(item?.item_id, "menu item");
    const line = { itemId: item.item_id, quantity: 1, instructions: ["No onion"] };
    const goods = Number(item.price_cents);
    const taxableGoods = item.taxApplicable === false || item.tax_applicable === 0 ? 0 : goods;
    const tax = mulDivRoundHalfUp(taxableGoods, 1000, 10000);

    const takeaway = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-TAKEAWAY",
      orderType: "TAKEAWAY",
      lines: [line],
    });
    assert(takeaway.status === 201, takeaway.json?.error || "takeaway still works");
    assert(!getOrder(takeaway.json.order.order_id).customer_id, "takeaway without a customer");
    assert(getOrder(takeaway.json.order.order_id).delivery_charge_cents === 0, "takeaway has no delivery fee");

    const counter = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-COUNTER",
      orderType: "COUNTER",
      lines: [line],
    });
    assert(counter.status === 201, counter.json?.error || "counter without customer");
    assert(getOrder(counter.json.order.order_id).delivery_charge_cents === 0, "counter has no delivery fee");

    const dine = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-DINE",
      orderType: "DINE_IN",
      fulfillment: { tableNumber: "4" },
      lines: [line],
    });
    assert(dine.status === 201, dine.json?.error || "dine in without customer");
    assert(getOrder(dine.json.order.order_id).table_number === "4", "table still required");
    assert(!getOrder(dine.json.order.order_id).customer_id, "dine in customer stays optional");

    const car = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-CAR",
      orderType: "CAR_HOP",
      fulfillment: { vehicleNumber: "", parkingLocation: "" },
      lines: [line],
    });
    assert(car.status === 201, car.json?.error || "car hop without customer");
    assert(!getOrder(car.json.order.order_id).vehicle_number, "vehicle stays optional");

    const customType = await httpJson(port, "PUT", "/v1/order-types", admin, {
      name: "Window",
      behavior: "COUNTER",
      isActive: true,
    });
    assert(customType.status === 200, customType.json?.error || "custom type");
    const windowOrder = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-WINDOW",
      orderType: customType.json.orderType.code,
      fulfillment: { customerId: ali.json.customer.customerId },
      lines: [line],
    });
    assert(windowOrder.status === 201, windowOrder.json?.error || "custom type with customer");
    assert(getOrder(windowOrder.json.order.order_id).customer_id === ali.json.customer.customerId, "custom type stores the customer");
    assert(getOrder(windowOrder.json.order.order_id).customer_phone === "33111222", "custom type uses the saved phone");
    assert(getOrder(windowOrder.json.order.order_id).delivery_charge_cents === 0, "custom type has no delivery fee");
    assert(!getOrder(windowOrder.json.order.order_id).block_number, "custom type does not snapshot a block");

    for (const [orderNumber, orderType, extra] of [
      ["CUST-TW-ALI", "TAKEAWAY", {}],
      ["CUST-CT-ALI", "COUNTER", { counterLabel: "Front" }],
      ["CUST-DN-ALI", "DINE_IN", { tableNumber: "8" }],
      ["CUST-CH-ALI", "CAR_HOP", { vehicleNumber: "12345" }],
    ]) {
      const selected = await httpJson(port, "POST", "/v1/test-orders", device, {
        orderNumber,
        orderType,
        fulfillment: { customerId: ali.json.customer.customerId, customerPhone: "000", ...extra },
        lines: [line],
      });
      assert(selected.status === 201, selected.json?.error || orderType);
      const saved = getOrder(selected.json.order.order_id);
      assert(saved.customer_id === ali.json.customer.customerId, `${orderType} keeps the customer id`);
      assert(saved.customer_phone === "33111222", `${orderType} uses the saved phone`);
      assert(saved.delivery_charge_cents === 0, `${orderType} does not charge delivery`);
      assert(saved.total_cents === goods + tax, `${orderType} total excludes delivery`);
    }

    const strayFee = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-STRAY-FEE",
      orderType: "TAKEAWAY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        deliveryChargeCents: 300,
        blockNumber: "361",
      },
      lines: [line],
    });
    assert(strayFee.status === 400, "non-delivery rejects a delivery charge");

    const foreignCustomer = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-FOREIGN",
      orderType: "COUNTER",
      fulfillment: { customerId: otherId },
      lines: [line],
    });
    assert(foreignCustomer.status === 400, "other shop customer rejected");

    const missingCustomer = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-NOCUST",
      orderType: "DELIVERY",
      fulfillment: {
        blockNumber: "361",
        deliveryChargeCents: 300,
        deliveryFeeOverride: false,
        expectedBlockRateCents: 300,
      },
      lines: [line],
    });
    assert(missingCustomer.status === 400, "delivery requires a customer");
    const noPhone = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-NOPHONE",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: bareId,
        blockNumber: "361",
        deliveryChargeCents: 300,
        deliveryFeeOverride: false,
        expectedBlockRateCents: 300,
      },
      lines: [line],
    });
    assert(noPhone.status === 400, "delivery requires a contact number");
    const noBlock = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-NOBLOCK",
      orderType: "DELIVERY",
      fulfillment: { customerId: ali.json.customer.customerId, deliveryChargeCents: 300 },
      lines: [line],
    });
    assert(noBlock.status === 400, "delivery requires a block");
    const noCharge = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-NOCHARGE",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        blockNumber: "8800",
        deliveryFeeOverride: false,
      },
      lines: [line],
    });
    assert(noCharge.status === 400, "unlisted block requires an explicit charge");

    const auto = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-AUTO",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        customerPhone: "000",
        buildingNumber: "10",
        roadNumber: "20",
        blockNumber: "361",
        addressNote: "Blue gate",
        deliveryChargeCents: 300,
        deliveryFeeOverride: false,
        expectedBlockRateCents: 300,
      },
      lines: [line],
    });
    assert(auto.status === 201, auto.json?.error || "listed block order");
    const autoOrder = getOrder(auto.json.order.order_id);
    assert(autoOrder.customer_id === ali.json.customer.customerId, "customer snapshot");
    assert(autoOrder.customer_phone === "33111222", "order uses the saved phone");
    assert(autoOrder.delivery_charge_cents === 300, "configured fee");
    assert(autoOrder.delivery_rate_source === "master", "master rate source");
    assert(autoOrder.tax_cents === tax, "item tax unchanged");
    assert(autoOrder.total_cents === goods + tax + 300, "fee added once");

    const editedAddress = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-ADDR",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        buildingNumber: "99",
        roadNumber: "20",
        blockNumber: "361",
        deliveryChargeCents: 100,
        deliveryFeeOverride: true,
        expectedBlockRateCents: 300,
      },
      lines: [line],
    });
    assert(editedAddress.status === 201, editedAddress.json?.error || "order address");
    assert(getOrder(editedAddress.json.order.order_id).building_number === "99", "order address snapshot");
    const aliStill = await httpJson(port, "GET", `/v1/customers/${ali.json.customer.customerId}`, device);
    assert(aliStill.json.customer.buildingNumber === "10", "order edit does not rewrite the customer");

    const savedAddress = await httpJson(port, "PUT", `/v1/customers/${ali.json.customer.customerId}`, device, {
      buildingNumber: "15",
      roadNumber: "20",
      blockNumber: "361",
      addressNote: "Blue gate",
    });
    assert(savedAddress.status === 200, "explicit address save");
    assert(savedAddress.json.customer.buildingNumber === "15", "saved address");
    assert(savedAddress.json.customer.phone === "33111222", "phone unchanged");
    const ratesAfterSave = await httpJson(port, "GET", "/v1/block-delivery-rates", admin);
    assert(
      ratesAfterSave.json.rates.find((row) => row.blockNumber === "361").chargeCents === 300,
      "address save does not change the block rate"
    );

    const home = savedAddress.json.customer.addresses.find((row) => row.isDefault);
    assert(home?.addressId, "default address id");
    const office = await httpJson(
      port,
      "POST",
      `/v1/customers/${ali.json.customer.customerId}/addresses`,
      device,
      {
        label: "Office",
        buildingNumber: "455",
        roadNumber: "1201",
        blockNumber: "321",
        addressNote: "Front desk",
      }
    );
    assert(office.status === 201, office.json?.error || "second address");
    const officeAddr = office.json.customer.addresses.find((row) => row.label === "Office");
    const homeAfter = office.json.customer.addresses.find((row) => row.addressId === home.addressId);
    assert(officeAddr?.blockNumber === "321", "second address block");
    assert(homeAfter.buildingNumber === "15", "second address did not rewrite the first");
    const editedHome = await httpJson(
      port,
      "PUT",
      `/v1/customers/${ali.json.customer.customerId}/addresses/${home.addressId}`,
      device,
      {
        label: "Home",
        buildingNumber: "1930",
        roadNumber: "6361",
        blockNumber: "361",
        addressNote: "Near Abriq",
      }
    );
    assert(editedHome.status === 200, editedHome.json?.error || "edit address");
    const homeEdited = editedHome.json.customer.addresses.find((row) => row.addressId === home.addressId);
    const officeStill = editedHome.json.customer.addresses.find((row) => row.addressId === officeAddr.addressId);
    assert(homeEdited.buildingNumber === "1930", "edited address");
    assert(officeStill.buildingNumber === "455", "edit did not change the other address");
    const preferred = await httpJson(
      port,
      "PUT",
      `/v1/customers/${ali.json.customer.customerId}/addresses/${officeAddr.addressId}`,
      device,
      {
        label: "Office",
        buildingNumber: "455",
        roadNumber: "1201",
        blockNumber: "321",
        addressNote: "Front desk",
        isDefault: true,
      }
    );
    assert(preferred.json.customer.blockNumber === "321", "default address drives the customer summary");
    assert(
      preferred.json.customer.addresses.find((row) => row.addressId === home.addressId).isDefault === false,
      "only one default address"
    );
    assert(getOrder(editedAddress.json.order.order_id).building_number === "99", "old order snapshot unchanged");
    const foreignAddress = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-FOREIGN-ADDR",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        addressId: sara.json.customer.addresses[0].addressId,
        blockNumber: "361",
        deliveryChargeCents: 300,
        deliveryFeeOverride: false,
        expectedBlockRateCents: 300,
      },
      lines: [line],
    });
    assert(foreignAddress.status === 400, "address from another customer is rejected");
    const picked = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-OFFICE",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        addressId: officeAddr.addressId,
        buildingNumber: "455",
        roadNumber: "1201",
        blockNumber: "321",
        addressNote: "Front desk",
        deliveryChargeCents: 150,
        deliveryFeeOverride: true,
      },
      lines: [line],
    });
    assert(picked.status === 201, picked.json?.error || "selected address order");
    const pickedOrder = getOrder(picked.json.order.order_id);
    assert(pickedOrder.customer_address_id === officeAddr.addressId, "order stores the address id");
    assert(pickedOrder.block_number === "321", "selected address block");
    assert(pickedOrder.building_number === "455", "selected address snapshot");
    const bare = await httpJson(port, "POST", "/v1/customers", device, {
      name: "Walk In",
      phone: "32001111",
    });
    assert(bare.status === 201, bare.json?.error || "customer without address");
    assert(bare.json.customer.addresses.length === 0, "address is optional outside delivery");

    const missingFee = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-NOFEE",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: sara.json.customer.customerId,
        blockNumber: "8800",
        deliveryFeeOverride: false,
      },
      lines: [line],
    });
    assert(missingFee.status === 400, "missing fee rejected");

    const unlisted = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-UNLISTED",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: sara.json.customer.customerId,
        blockNumber: "8800",
        deliveryChargeCents: 250,
        deliveryFeeOverride: true,
      },
      lines: [line],
    });
    assert(unlisted.status === 201, unlisted.json?.error || "unlisted block");
    const unlistedOrder = getOrder(unlisted.json.order.order_id);
    assert(unlistedOrder.block_number === "8800", "unlisted block snapshot");
    assert(unlistedOrder.configured_delivery_cents == null, "no master rate");
    assert(unlistedOrder.delivery_rate_source === "unlisted", "unlisted source");
    assert(unlistedOrder.delivery_charge_cents === 250, "explicit fee");
    assert(unlistedOrder.total_cents === goods + tax + 250, "unlisted total");
    const afterRates = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM shop_block_delivery_rates WHERE shop_id = ?`)
      .get(shopId).n;
    assert(afterRates === beforeRates, "unlisted block does not create a master rate");

    const zero = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-ZERO",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: sara.json.customer.customerId,
        blockNumber: "8800",
        deliveryChargeCents: 0,
        deliveryFeeOverride: true,
      },
      lines: [line],
    });
    assert(zero.status === 201, zero.json?.error || "explicit zero");
    assert(getOrder(zero.json.order.order_id).delivery_charge_cents === 0, "zero fee stored");
    assert(getOrder(zero.json.order.order_id).total_cents === goods + tax, "zero fee leaves item tax");

    const next = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-NEXT",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: ali.json.customer.customerId,
        blockNumber: "361",
        deliveryChargeCents: 300,
        deliveryFeeOverride: false,
        expectedBlockRateCents: 300,
      },
      lines: [line],
    });
    assert(next.status === 201, "next listed order");
    assert(getOrder(next.json.order.order_id).delivery_charge_cents === 300, "custom fee was not carried forward");
    assert(getOrder(editedAddress.json.order.order_id).delivery_charge_cents === 100, "earlier override stays on its order");

    const feeAudit = getDb()
      .prepare(
        `SELECT detail_json FROM audit_events
         WHERE action = 'order.delivery_fee.override' AND entity_id = ?`
      )
      .get(unlistedOrder.order_id);
    const feeDetail = JSON.parse(feeAudit.detail_json);
    assert(feeDetail.configuredChargeCents == null, "audit records no master rate");
    assert(feeDetail.appliedChargeCents === 250, "audit applied amount");
    assert(feeDetail.rateSource === "unlisted", "audit source");
    assert(feeDetail.deviceId === sessions.cashierDeviceId, "audit operator");
    assert(!JSON.stringify(feeDetail).includes("token"), "audit has no token");

    const retry = await httpJson(port, "POST", "/v1/test-orders", device, {
      orderNumber: "CUST-UNLISTED",
      orderType: "DELIVERY",
      fulfillment: {
        customerId: sara.json.customer.customerId,
        blockNumber: "8800",
        deliveryChargeCents: 10,
        deliveryFeeOverride: true,
      },
      lines: [line],
    });
    assert(retry.status === 409 && retry.json.code === "SUBMISSION_CONFLICT", "different fee rejected");
    assert(getOrder(unlistedOrder.order_id).delivery_charge_cents === 250, "retry keeps the fee");

    const cashier = (unlisted.json.jobs || []).find((job) => job.job_type === "CASHIER");
    const kitchen = (unlisted.json.jobs || []).find((job) => job.job_type === "KITCHEN");
    const cashierText = await httpJson(
      port,
      "GET",
      `/v1/print-jobs/${encodeURIComponent(cashier.job_id)}/preview`,
      device
    );
    const kitchenText = await httpJson(
      port,
      "GET",
      `/v1/print-jobs/${encodeURIComponent(kitchen.job_id)}/preview`,
      device
    );
    assert(/Delivery charge/i.test(cashierText.json.text), "receipt shows the fee");
    assert(/BLOCK: 8800/i.test(kitchenText.json.text), "kitchen keeps the block");
    assert(!/Delivery charge/i.test(kitchenText.json.text), "kitchen omits the fee");
    const dispatched = await httpJson(port, "POST", "/v1/dispatch/run", admin);
    assert(
      dispatched.json.processed.some((row) => row.status === "DISPATCHED"),
      "mock printer dispatched"
    );
    pass("customers-and-delivery");
  } catch (err) {
    fail("customers-and-delivery", err);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((row) => !row.ok);
  log.info(`customers ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
