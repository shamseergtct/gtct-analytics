import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";
import { authenticateRequest, requireRole } from "../auth.js";
import { authAllows } from "../services/staffAuth.js";
import {
  listStaffUsers,
  createStaffUser,
  updateStaffUser,
  resetStaffPassword,
  listAssignablePrepStations,
  listKitchenStationIds,
} from "../services/staffUsers.js";
import {
  resetPasswordWithSupportMasterKey,
  supportMasterKeyConfigured,
} from "../services/supportRecovery.js";
import {
  loginWithToken,
  loginWithPassword,
  logoutRequest,
  readSessionId,
  isTrustedBrowserOrigin,
} from "../sessions.js";
import { listStations, getStation, upsertStation, removeStation } from "../services/stations.js";
import {
  listPrinters,
  getPrinter,
  upsertPrinter,
} from "../services/printers.js";
import {
  listMenuItems,
  getMenuItem,
  upsertMenuItem,
  reorderMenuItems,
  updateMenuItemAvailability,
  saveMenuItemImage,
  saveSubcategoryImage,
  clearSubcategoryImage,
  clearMenuItemImage,
  resolveMenuImagePath,
} from "../services/menuMappings.js";
import {
  exportMenuItemsCsv,
  exportMenuItemsTemplateCsv,
  importMenuItemsCsv,
} from "../services/menuBulk.js";
import {
  listCategories,
  upsertCategory,
  upsertSubcategory,
  reorderCategories,
  reorderSubcategories,
} from "../services/categories.js";
import {
  getShopSettings,
  updateShopSettings,
  applyEnvShopOverrides,
  shopSettingsAuditDetail,
} from "../services/shopSettings.js";
import {
  saveShopLogo,
  clearShopLogo,
  resolveShopLogoPath,
} from "../services/shopLogo.js";
import { buildTaxPreviewSamples } from "../services/tax.js";
import { renderShopReceiptPreview } from "../print/ticketFormat.js";
import {
  getKitchenLibrary,
  upsertModifier,
  upsertTarget,
  upsertStandalone,
  setOptionActive,
  setItemInstructionConfig,
  getItemInstructionConfig,
  legacyKitchenNotesFromLibrary,
} from "../services/kitchenLibrary.js";
import {
  listAddons,
  getAddon,
  upsertAddon,
  listAddonAssignments,
  getItemAddons,
  setItemAddons,
} from "../services/addons.js";
import {
  getProductKnowledge,
  upsertProductKnowledge,
  knowledgeHasDisplayContent,
} from "../services/productKnowledge.js";
import { formatMoneyMinor } from "../util/money.js";
import {
  listOrderTypes,
  upsertOrderType,
  reorderOrderTypes,
  listBlockRates,
  upsertBlockRate,
} from "../services/orderSetup.js";
import {
  searchCustomers,
  findCustomerByPhone,
  getCustomer,
  createCustomer,
  updateCustomerAddress,
  updateCustomerProfile,
  addCustomerAddress,
  updateCustomerAddressById,
} from "../services/customers.js";
import {
  getLatestCaller,
  recordIncomingCaller,
  clearLatestCaller,
} from "../services/callerId.js";
import {
  peekNextOrderNumber,
  createTestOrder,
  getOrder,
  loadOrderForEdit,
  countOrders,
  clearTestOrders,
} from "../services/orders.js";
import {
  getDataCleaningSummary,
  runDataCleaning,
} from "../services/dataCleaning.js";
import { listOrderRegister, getOrderRegisterDetail } from "../services/orderRegister.js";
import { voidUnpaidTestOrder } from "../services/orderVoid.js";
import { getBusinessShift, openBusinessShift, closeBusinessShift } from "../services/businessShifts.js";
import { listPrepBoard, setPrepStatus } from "../services/prepBoard.js";
import {
  listOrderMonitor,
  getOrderMonitorDetail,
  markOrderReadyForDelivery,
  unmarkOrderReadyForDelivery,
} from "../services/orderMonitor.js";
import { listAvailableDeliveries, listMyDeliveries, acceptAvailableDelivery, listRouteSuggestions, getDeliveryBill } from "../services/deliveryPool.js";
import {
  syncCloudDeliveryBridge,
  resetCloudBridgeBackoff,
  cloudBridgeSecretStatus,
  saveCloudBridgeSecret,
  cloudBridgeActivationStatus,
  activateCloudBridge,
  deactivateCloudBridge,
} from "../services/cloudDeliveryBridge.js";
import {
  readSplitReview,
  confirmSplitShopPaid,
  approveSplitCredit,
  rejectSplitCredit,
} from "../services/deliverySplitReview.js";
import { decideReleaseRequest } from "../services/deliveryReleaseRequests.js";
import { getDb } from "../db/db.js";
import { markDeliveryPayment } from '../services/deliveryPaymentReports.js';
import { listDeliveryCashHandovers, confirmDeliveryCashHandover }
  from '../services/deliveryCashHandover.js';
import { listCommissionSettings, saveCommissionSetting, commissionPreview }
  from '../services/deliveryCommissionSettings.js';
import { previewCommissionAccrual, listCommissionAccruals, approveCommissionAccrual }
  from '../services/deliveryCommissionAccruals.js';
import { listRiderNetSettlements, confirmRiderNetSettlement, correctRiderSettlementTender }
  from '../services/deliveryRiderNetSettlement.js';
import { markDeliveryLifecycle, shopReviewDeliveryCancellation, reviewDeliveryCredit, shopSetDirectCredit }
  from '../services/deliveryLifecycle.js';
import {
  listPrintJobs,
  getPrintJob,
  applyCashierCategories,
  clearPrintJobHistory,
} from "../services/printQueue.js";
import {
  processAllPending,
  confirmJob,
  requestReprint,
} from "../print/dispatcher.js";
import { renderTicketText } from "../print/ticketFormat.js";
import { runPrinterTest, previewPrinterTicket } from "../services/printerTest.js";
import { recordAudit, listAuditEvents } from "../services/audit.js";
import { recordPaymentAllocation, listPaymentAllocations } from '../services/paymentAllocations.js';
import {
  settleCashPayment,
  getOrderPayment,
  listPendingPayments,
  toPublicSettlementError,
} from "../services/settlements.js";
import {
  listSalesBankAccounts,
  listManagedBankAccounts,
  createBankAccount,
  updateBankAccount,
  toPublicBankError,
} from "../services/bankAccounts.js";
import { tryServeStatic } from "./static.js";
import { log } from "../util/logger.js";
import { getTestBackupHealth } from "../backup/testBackupManagement.js";
import {
  exportPortableBackup,
  importPortableBackup,
  portableBackupConfirmPhrase,
} from "../services/portableBackup.js";
import { getPilotSetupStatus, bootstrapPilotSetup } from "../services/pilotSetup.js";
import {
  getPrintSettings,
  updatePrintSettings,
  isPhysicalPrintEffectivelyEnabled,
  envPhysicalPrintOverride,
} from "../services/printSettings.js";
import { getShopReports, listReportShifts } from "../services/reports.js";
import {
  listTerminals,
  upsertTerminal,
  createPairingCode,
  revokeTerminalPairing,
  pairTerminalWithCode,
  resolvePairedTerminal,
  terminalCookieHeader,
  lanTerminalStatus,
} from "../services/terminals.js";

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function contentTypeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function cookieMutationBlocked(req, config, method) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (!readSessionId(req)) return false;
  return !isTrustedBrowserOrigin(req, config);
}

function sessionPayload(auth) {
  return {
    authenticated: true,
    role: auth.role,
    deviceId: auth.deviceId,
    via: auth.via || "session",
    staff: Boolean(auth.staff),
    userId: auth.userId || "",
    username: auth.username || "",
    fullName: auth.fullName || "",
    terminalId: auth.terminalId || "",
    terminalName: auth.terminalName || "",
    permissions: auth.staff ? auth.permissions || [] : [],
    canAdjustAddonPrices: authAllows(auth, "sales.addon_price_override"),
    canAdjustBasePrices: authAllows(auth, "sales.price_override"),
  };
}

function printersForRole(printers, auth) {
  if (auth?.role === "admin") return printers;
  return printers.map((printer) => {
    const copy = { ...printer };
    delete copy.host;
    delete copy.port;
    delete copy.windows_queue_name;
    return copy;
  });
}

function forbidUnless(auth, res, code) {
  if (authAllows(auth, code)) return false;
  sendJson(res, 403, { error: "You do not have permission for this action." });
  return true;
}

function requireStaffAdmin(req, res, config) {
  const auth = requireAuth(req, res, config, ["admin"]);
  if (!auth) return null;
  if (!auth.staff || !authAllows(auth, "staff.manage")) {
    sendJson(res, 403, { error: "Administrator privileges required" });
    return null;
  }
  return auth;
}

function requireAuth(req, res, config, roles = ["device", "admin", "cashier"]) {
  let auth = authenticateRequest(req, config);
  auth = requireRole(auth, roles);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return null;
  }
  return auth;
}

export function createServer(config) {
  const handler = async (req, res) => {
    try {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );
      const path = url.pathname;
      const method = req.method || "GET";

      if (method === "GET" && path === "/health") {
        sendJson(res, 200, {
          ok: true,
          service: "gtct-restaurant-local-server",
          loopback: config.loopback,
          lanAccessReady: config.lanAccessReady === true,
          tlsReady: config.tlsReady === true,
        });
        return;
      }

      if (cookieMutationBlocked(req, config, method)) {
        sendJson(res, 403, {
          error: "This action was blocked. Refresh the page and try again.",
        });
        return;
      }

      // --- First-run TEST PILOT setup (no admin yet; loopback only) ---
      if (method === "GET" && path === "/v1/setup/status") {
        if (!config.loopback) {
          sendJson(res, 403, { error: "Setup status is only available on this computer." });
          return;
        }
        sendJson(res, 200, getPilotSetupStatus(config));
        return;
      }
      if (method === "POST" && path === "/v1/setup/bootstrap") {
        if (!config.loopback) {
          sendJson(res, 403, { error: "First-run setup is only allowed on this computer." });
          return;
        }
        try {
          const body = await readBody(req);
          const result = bootstrapPilotSetup(config, body && typeof body === "object" ? body : {});
          sendJson(res, 201, result);
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message || "Setup could not be completed.",
            code: err.code || undefined,
          });
        }
        return;
      }

      // --- Loopback UI session (no tokens embedded in static assets) ---
      if (method === "POST" && path === "/v1/session/login") {
        const body = await readBody(req);
        const record = body && typeof body === "object" && !Array.isArray(body) ? body : {};
        const usingPassword =
          Object.prototype.hasOwnProperty.call(record, "username") ||
          Object.prototype.hasOwnProperty.call(record, "password");
        const result = usingPassword
          ? loginWithPassword(req, config, {
              username: record.username,
              password: record.password,
            })
          : loginWithToken(req, config, record.token);
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        sendJson(
          res,
          200,
          {
            ok: true,
            role: result.role,
            deviceId: result.deviceId,
            terminalId: result.terminalId || "",
            terminalName: result.terminalName || "",
          },
          { "Set-Cookie": result.cookie }
        );
        return;
      }

      if (method === "GET" && path === "/v1/recovery/status") {
        if (!isTrustedBrowserOrigin(req, config)) {
          sendJson(res, 403, { error: "Open recovery from this restaurant’s page." });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          supportMasterEnabled: supportMasterKeyConfigured(config),
        });
        return;
      }

      if (method === "POST" && path === "/v1/recovery/support-reset") {
        if (!isTrustedBrowserOrigin(req, config)) {
          sendJson(res, 403, { error: "Open recovery from this restaurant’s page." });
          return;
        }
        const body = await readBody(req);
        const result = resetPasswordWithSupportMasterKey(req, config, body);
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        sendJson(res, 200, { ok: true, username: result.username });
        return;
      }

      if (method === "POST" && path === "/v1/session/logout") {
        const result = logoutRequest(req, config);
        sendJson(res, 200, { ok: true }, { "Set-Cookie": result.cookie });
        return;
      }

      if (method === "GET" && path === "/v1/terminals/status") {
        const auth = requireAuth(req, res, config, ["admin", "cashier", "kitchen", "delivery"]);
        if (!auth) return;
        const paired = resolvePairedTerminal(config.testTenantId, req);
        sendJson(res, 200, {
          lan: lanTerminalStatus(config),
          pairedTerminal: paired,
        });
        return;
      }

      if (method === "POST" && path === "/v1/terminals/pair") {
        if (!isTrustedBrowserOrigin(req, config)) {
          sendJson(res, 403, {
            error: "Pairing must come from this shop’s restaurant page.",
          });
          return;
        }
        try {
          const body = await readBody(req);
          const paired = pairTerminalWithCode(
            config.testTenantId,
            body?.code || body?.pairingCode || ""
          );
          sendJson(
            res,
            200,
            { ok: true, terminal: paired.terminal },
            {
              "Set-Cookie": terminalCookieHeader(paired.token, {
                secure: Boolean(req.socket?.encrypted),
              }),
            }
          );
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (method === "GET" && path === "/v1/terminals/me") {
        const paired = resolvePairedTerminal(config.testTenantId, req);
        sendJson(res, 200, { terminal: paired });
        return;
      }

      if (path === "/v1/terminals" || path.startsWith("/v1/terminals/")) {
        if (method === "GET" && path === "/v1/terminals") {
          const auth = requireStaffAdmin(req, res, config);
          if (!auth) return;
          sendJson(res, 200, {
            terminals: listTerminals(config.testTenantId),
            lan: lanTerminalStatus(config),
          });
          return;
        }
        if (method === "PUT" && path === "/v1/terminals") {
          const auth = requireStaffAdmin(req, res, config);
          if (!auth) return;
          try {
            const body = await readBody(req);
            const terminal = upsertTerminal(config.testTenantId, body, {
              role: auth.role,
              userId: auth.userId || "",
            });
            sendJson(res, 200, { terminal });
          } catch (err) {
            sendJson(res, err.status || 400, {
              error: err.message,
              ...(err.code ? { code: err.code } : {}),
            });
          }
          return;
        }
        const pairMatch = /^\/v1\/terminals\/([^/]+)\/pairing-code$/.exec(path);
        if (method === "POST" && pairMatch) {
          const auth = requireStaffAdmin(req, res, config);
          if (!auth) return;
          try {
            const issued = createPairingCode(
              config.testTenantId,
              decodeURIComponent(pairMatch[1]),
              { role: auth.role, userId: auth.userId || "" }
            );
            sendJson(res, 200, issued);
          } catch (err) {
            sendJson(res, err.status || 400, {
              error: err.message,
              ...(err.code ? { code: err.code } : {}),
            });
          }
          return;
        }
        const revokeMatch = /^\/v1\/terminals\/([^/]+)\/revoke$/.exec(path);
        if (method === "POST" && revokeMatch) {
          const auth = requireStaffAdmin(req, res, config);
          if (!auth) return;
          try {
            const terminal = revokeTerminalPairing(
              config.testTenantId,
              decodeURIComponent(revokeMatch[1]),
              { role: auth.role, userId: auth.userId || "" }
            );
            sendJson(res, 200, { terminal });
          } catch (err) {
            sendJson(res, err.status || 400, {
              error: err.message,
              ...(err.code ? { code: err.code } : {}),
            });
          }
          return;
        }
      }

      if (path === "/v1/staff-users" || path.startsWith("/v1/staff-users/")) {
        const auth = requireStaffAdmin(req, res, config);
        if (!auth) return;
        const actor = { role: auth.role, userId: auth.userId || "" };
        try {
          if (method === "GET" && path === "/v1/staff-users") {
            sendJson(res, 200, { users: listStaffUsers(config.testTenantId) });
            return;
          }
          if (method === "GET" && path === "/v1/staff-users/stations") {
            sendJson(res, 200, { stations: listAssignablePrepStations() });
            return;
          }
          if (method === "POST" && path === "/v1/staff-users") {
            const body = await readBody(req);
            if (body.shopId && body.shopId !== config.testTenantId) {
              sendJson(res, 403, { error: "shopId is not allowed for this server instance" });
              return;
            }
            const user = createStaffUser(config.testTenantId, body, actor);
            sendJson(res, 201, { user });
            return;
          }
          const rest = path.slice("/v1/staff-users/".length);
          const [rawId, action] = rest.split("/");
          const userId = decodeURIComponent(rawId || "");
          if (!userId || rest.split("/").length > 2) {
            sendJson(res, 404, { error: "Staff member not found." });
            return;
          }
          if (method === "PATCH" && !action) {
            const body = await readBody(req);
            if (body.shopId && body.shopId !== config.testTenantId) {
              sendJson(res, 403, { error: "shopId is not allowed for this server instance" });
              return;
            }
            const user = updateStaffUser(config.testTenantId, userId, body, actor);
            sendJson(res, 200, { user });
            return;
          }
          if (method === "POST" && action === "password") {
            const body = await readBody(req);
            const result = resetStaffPassword(config.testTenantId, userId, body, actor);
            sendJson(res, 200, result);
            return;
          }
          sendJson(res, 404, { error: "Staff member not found." });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message || "Could not update staff." });
        }
        return;
      }

      // P2-C3: only a signed-in staff Admin can read backup health. Never expose filesystem paths.
      if (method === "GET" && path === "/v1/admin/backup-health") {
        if (!requireStaffAdmin(req, res, config)) return;
        sendJson(res, 200, getTestBackupHealth());
        return;
      }

      if (method === "GET" && path === "/v1/admin/backup/info") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        sendJson(res, 200, {
          confirmPhrase: portableBackupConfirmPhrase(config.testTenantId),
          shopId: config.testTenantId,
          scope: "SQLITE_ONLY",
          note: "Menu photos stored as files are not inside the SQLite backup.",
        });
        return;
      }

      if (method === "POST" && path === "/v1/admin/backup/export") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const payload = await exportPortableBackup(config);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "backup.export",
            entityType: "database",
            entityId: "portable",
            detail: {
              filename: payload.filename,
              bytes: payload.bytes,
              sha256: payload.sha256,
            },
          });
          sendJson(res, 200, payload);
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message });
        }
        return;
      }

      if (method === "POST" && path === "/v1/admin/backup/import") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req, { maxBytes: 340_000_000 });
          const result = await importPortableBackup(config, {
            base64Data: body.base64Data,
            confirmPhrase: body.confirmPhrase,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "backup.import",
            entityType: "database",
            entityId: "portable",
            detail: {
              bytes: result.bytes,
              sha256: result.sha256,
              safetyCopyKept: result.safetyCopyKept,
            },
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/session/me") {
        const auth = authenticateRequest(req, config);
        if (!auth.ok) {
          sendJson(res, 401, { authenticated: false });
          return;
        }
        sendJson(res, 200, sessionPayload(auth));
        return;
      }

      if (method === "GET" && path === "/v1/config") {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        const shop = applyEnvShopOverrides(
          getShopSettings(config.testTenantId),
          config
        );
        const printSettings = getPrintSettings();
        sendJson(res, 200, {
          testTenantId: config.testTenantId,
          restaurantDisplayName: shop.displayName || config.restaurantDisplayName,
          physicalPrintEnabled: isPhysicalPrintEffectivelyEnabled(config),
          physicalPrintEnvOverride: envPhysicalPrintOverride(),
          printSettings,
          allowTcpProbe: config.allowTcpProbe,
          lanAccessReady: config.lanAccessReady === true,
          tlsReady: config.tlsReady === true,
          canAdjustAddonPrices: authAllows(auth, "sales.addon_price_override"),
          canAdjustBasePrices: authAllows(auth, "sales.price_override"),
          loopback: config.loopback,
          shop: {
            shopId: shop.shopId,
            displayName: shop.displayName,
            currencyCode: shop.currencyCode,
            currencyLabel: shop.currencyLabel,
            currencyDecimals: shop.currencyDecimals,
            taxEnabled: shop.taxEnabled,
            taxMode: shop.taxMode,
            taxName: shop.taxName,
            taxRateBps: shop.taxRateBps,
            taxRatePercent: shop.taxRatePercent,
            timezone: shop.timezone,
            dateFormat: shop.dateFormat,
            subcategoryDisplay: shop.subcategoryDisplay,
          },
        });
        return;
      }

      if (method === "GET" && path === "/v1/shop-settings") {
        if (!requireAuth(req, res, config)) return;
        const shop = applyEnvShopOverrides(
          getShopSettings(config.testTenantId),
          config
        );
        const orderCounts = countOrders(config.testTenantId);
        sendJson(res, 200, {
          shop,
          moneyExample: formatMoneyMinor(1500, shop),
          taxPreviewSamples: buildTaxPreviewSamples(shop),
          orderCount: orderCounts.total,
          testOrderCount: orderCounts.testCount,
          currencyLockedByOrders: orderCounts.total > 0,
          note:
            "price_cents are integer minor units. Changing decimals does not rescale stored prices. Currency code/precision changes are blocked while orders exist — clear test orders first (admin).",
        });
        return;
      }

      if (method === "PUT" && path === "/v1/shop-settings") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const before = getShopSettings(config.testTenantId);
          const shop = updateShopSettings(config.testTenantId, body, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "shop.settings.update",
            entityType: "shop_settings",
            entityId: shop.shopId,
            detail: shopSettingsAuditDetail(before, shop),
          });
          sendJson(res, 200, { shop });
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            code: err.code,
          });
        }
        return;
      }

      if (path === "/v1/cloud-delivery-bridge/activation" || path === "/v1/cloud-delivery-bridge/activate") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          if (method === "GET" && path.endsWith("/activation")) {
            sendJson(res, 200, { activation: cloudBridgeActivationStatus(config) });
            return;
          }
          let activation;
          if (method === "POST" && path.endsWith("/activate")) {
            const body = await readBody(req);
            activation = await activateCloudBridge(config.testTenantId, config, body?.code);
          } else if (method === "DELETE" && path.endsWith("/activation")) {
            activation = deactivateCloudBridge(config);
          } else {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          resetCloudBridgeBackoff();
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: activation.activated ? "cloud_bridge.activate" : "cloud_bridge.deactivate",
            entityType: "shop_settings",
            entityId: "cloud_bridge_activation",
            detail: activation.activated
              ? { clientId: activation.clientId, deviceId: activation.deviceId }
              : {}, // never log codes or keys
          });
          sendJson(res, 200, { activation, shop: getShopSettings(config.testTenantId) });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }

      if (path === "/v1/cloud-delivery-bridge/secret" && (method === "GET" || method === "PUT")) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          if (method === "GET") {
            sendJson(res, 200, { secret: cloudBridgeSecretStatus(config) });
            return;
          }
          const body = await readBody(req);
          const status = saveCloudBridgeSecret(config, body?.secret);
          resetCloudBridgeBackoff();
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: status.set ? "cloud_bridge.secret.set" : "cloud_bridge.secret.clear",
            entityType: "shop_settings",
            entityId: "cloud_bridge_secret",
            detail: {}, // never log the key
          });
          sendJson(res, 200, { secret: status });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }

      if (method === "POST" && path === "/v1/cloud-delivery-bridge/sync") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          // Manual Sync now bypasses background cooldown and clears backoff on success.
          resetCloudBridgeBackoff();
          const result = await syncCloudDeliveryBridge(
            config.testTenantId,
            config
          );
          if (!result.skipped) resetCloudBridgeBackoff();
          sendJson(res, 200, { result });
        } catch (err) {
          sendJson(res, err.status || 500, {
            error: err.message,
            code: err.code,
          });
        }
        return;
      }

      if (method === "POST" && path === "/v1/shop-settings/receipt-preview") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          // Merge unsaved form values over current shop for preview only — no persist.
          const live = getShopSettings(config.testTenantId);
          const draft = { ...live, ...(body.shop || body) };
          if (body.receipt || draft.receipt) {
            draft.receipt = { ...live.receipt, ...(body.receipt || draft.receipt) };
          }
          if (body.taxEnabled != null) draft.taxEnabled = Boolean(body.taxEnabled);
          if (body.taxMode) draft.taxMode = body.taxMode;
          if (body.taxRateBps != null) draft.taxRateBps = Number(body.taxRateBps);
          if (body.taxRatePercent != null) {
            draft.taxRatePercent = String(body.taxRatePercent);
          }
          const samples = buildTaxPreviewSamples(draft);
          const mode = String(body.previewMode || "active");
          const breakdown =
            mode === "disabled"
              ? samples.disabled
              : mode === "exclusive"
                ? samples.exclusive
                : mode === "inclusive"
                  ? samples.inclusive
                  : samples.active;
          const text = renderShopReceiptPreview(draft, breakdown);
          sendJson(res, 200, {
            text,
            breakdown,
            samples,
            physicalPrintAttempted: false,
          });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/shop-settings/logo") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req, { maxBytes: 3_500_000 });
          const shop = saveShopLogo(
            config.testTenantId,
            {
              mimeType: body.mimeType || body.contentType,
              base64Data: body.base64Data || body.data,
            },
            config,
            { role: auth.role }
          );
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "shop.logo.upload",
            entityType: "shop_settings",
            entityId: shop.shopId,
            detail: { logoFilename: shop.logoFilename },
          });
          sendJson(res, 200, { shop });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "DELETE" && path === "/v1/shop-settings/logo") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const shop = clearShopLogo(config.testTenantId, config, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "shop.logo.clear",
            entityType: "shop_settings",
            entityId: shop.shopId,
            detail: {},
          });
          sendJson(res, 200, { shop });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path.startsWith("/v1/shop-logo/")) {
        if (!requireAuth(req, res, config)) return;
        const filename = decodeURIComponent(path.slice("/v1/shop-logo/".length));
        const filePath = resolveShopLogoPath(filename, config);
        if (!filePath) {
          sendJson(res, 404, { error: "Logo not found" });
          return;
        }
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime =
          ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : "image/jpeg";
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": buf.length,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(buf);
        return;
      }

      if (method === "GET" && path === "/v1/order-types") {
        if (!requireAuth(req, res, config)) return;
        sendJson(res, 200, {
          orderTypes: listOrderTypes(config.testTenantId),
          deliveryChargeTax: {
            perBlock: true,
            reason:
              "Each block delivery charge can include this shop’s tax. Set it when you add or edit the charge. Item and add-on tax is unchanged.",
          },
        });
        return;
      }

      if (method === "PUT" && path === "/v1/order-types/reorder") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const orderTypes = reorderOrderTypes(
            config.testTenantId,
            body.orderTypeIds
          );
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "order_type.reorder",
            entityType: "shop_order_type",
            entityId: config.testTenantId,
            detail: { orderTypeIds: body.orderTypeIds },
          });
          sendJson(res, 200, { orderTypes });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/order-types") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const orderType = upsertOrderType(config.testTenantId, body);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "order_type.upsert",
            entityType: "shop_order_type",
            entityId: orderType.orderTypeId,
            detail: {
              code: orderType.code,
              name: orderType.name,
              behavior: orderType.behavior,
              isActive: orderType.isActive,
            },
          });
          sendJson(res, 200, { orderType });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/block-delivery-rates") {
        if (!requireAuth(req, res, config)) return;
        sendJson(res, 200, { rates: listBlockRates(config.testTenantId) });
        return;
      }

      if (method === "PUT" && path === "/v1/block-delivery-rates") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const before = body.rateId
            ? listBlockRates(config.testTenantId).find((row) => row.rateId === body.rateId) || null
            : null;
          const rate = upsertBlockRate(config.testTenantId, body);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "delivery_block.upsert",
            entityType: "shop_block_delivery_rate",
            entityId: rate.rateId,
            detail: {
              blockNumber: rate.blockNumber,
              chargeCents: rate.chargeCents,
              previousChargeCents: before ? before.chargeCents : null,
              taxApplicable: rate.taxApplicable,
              isActive: rate.isActive,
            },
          });
          sendJson(res, 200, { rate });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/customers") {
        if (!requireAuth(req, res, config)) return;
        const q = url.searchParams.get("q") || "";
        sendJson(res, 200, { customers: searchCustomers(config.testTenantId, q) });
        return;
      }

      if (method === "GET" && path === "/v1/customers/by-phone") {
        if (!requireAuth(req, res, config)) return;
        const phone = url.searchParams.get("phone") || "";
        const customer = findCustomerByPhone(config.testTenantId, phone);
        sendJson(res, 200, { customer });
        return;
      }

      if (method === "GET" && path === "/v1/caller-id/latest") {
        if (!requireAuth(req, res, config)) return;
        sendJson(res, 200, getLatestCaller(config.testTenantId));
        return;
      }

      if (method === "POST" && path === "/v1/caller-id/incoming") {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const result = recordIncomingCaller(config.testTenantId, {
            phone: body.phone,
            source: body.source || "api",
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "caller_id.incoming",
            entityType: "caller",
            entityId: result.call.phoneKey,
            detail: {
              phone: result.call.phone,
              matched: Boolean(result.customer),
              customerId: result.customer?.customerId || "",
            },
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "POST" && path === "/v1/caller-id/clear") {
        if (!requireAuth(req, res, config)) return;
        sendJson(res, 200, clearLatestCaller(config.testTenantId));
        return;
      }

      if (method === "POST" && path === "/v1/customers") {
        const auth = requireAuth(req, res, config);
        if (!auth || forbidUnless(auth, res, "customers.manage")) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res, 403, { error: "shopId is not allowed for this server instance" });
            return;
          }
          const customer = createCustomer(config.testTenantId, body);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "customer.create",
            entityType: "shop_customer",
            entityId: customer.customerId,
            detail: { customerId: customer.customerId },
          });
          sendJson(res, 201, { customer });
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.customer ? { customer: err.customer } : {}),
          });
        }
        return;
      }

      if (path.startsWith("/v1/customers/")) {
        const parts = path
          .slice("/v1/customers/".length)
          .split("/")
          .filter(Boolean)
          .map((part) => {
            try {
              return decodeURIComponent(part);
            } catch {
              return "";
            }
          });
        const customerId = parts[0] || "";
        const addressId = parts[1] === "addresses" ? parts[2] || "" : "";
        const isAddress = parts[1] === "addresses" && parts.length <= 3;
        if (!customerId || parts.length > 3 || (parts[1] && parts[1] !== "addresses")) {
          sendJson(res, 404, { error: "Customer not found." });
          return;
        }
        if (!isAddress && method === "GET") {
          if (!requireAuth(req, res, config)) return;
          const customer = getCustomer(config.testTenantId, customerId);
          if (!customer) {
            sendJson(res, 404, { error: "Customer not found." });
            return;
          }
          sendJson(res, 200, { customer });
          return;
        }
        if (!isAddress && method === "PUT") {
          const auth = requireAuth(req, res, config);
          if (!auth || forbidUnless(auth, res, "customers.manage")) return;
          try {
            const body = await readBody(req);
            if (body.shopId && body.shopId !== config.testTenantId) {
              sendJson(res, 403, { error: "shopId is not allowed for this server instance" });
              return;
            }
            const profile = body.name != null || body.phone != null;
            const customer = profile
              ? updateCustomerProfile(config.testTenantId, customerId, body)
              : updateCustomerAddress(config.testTenantId, customerId, body);
            recordAudit({
              actorRole: auth.role,
            actorUserId: auth.userId || "",
              action: profile ? "customer.update" : "customer.address_update",
              entityType: "shop_customer",
              entityId: customer.customerId,
              detail: { customerId: customer.customerId },
            });
            sendJson(res, 200, { customer });
          } catch (err) {
            sendJson(res, err.status || 400, {
              error: err.message,
              ...(err.code ? { code: err.code } : {}),
              ...(err.customer ? { customer: err.customer } : {}),
            });
          }
          return;
        }
        if (isAddress && method === "POST" && !addressId) {
          const auth = requireAuth(req, res, config);
          if (!auth || forbidUnless(auth, res, "customers.manage")) return;
          try {
            const body = await readBody(req);
            if (body.shopId && body.shopId !== config.testTenantId) {
              sendJson(res, 403, { error: "shopId is not allowed for this server instance" });
              return;
            }
            const customer = addCustomerAddress(config.testTenantId, customerId, body);
            recordAudit({
              actorRole: auth.role,
            actorUserId: auth.userId || "",
              action: "customer.address_create",
              entityType: "shop_customer",
              entityId: customer.customerId,
              detail: { customerId: customer.customerId },
            });
            sendJson(res, 201, { customer });
          } catch (err) {
            sendJson(res, err.status || 400, { error: err.message });
          }
          return;
        }
        if (isAddress && method === "PUT" && addressId) {
          const auth = requireAuth(req, res, config);
          if (!auth || forbidUnless(auth, res, "customers.manage")) return;
          try {
            const body = await readBody(req);
            if (body.shopId && body.shopId !== config.testTenantId) {
              sendJson(res, 403, { error: "shopId is not allowed for this server instance" });
              return;
            }
            const customer = updateCustomerAddressById(
              config.testTenantId,
              customerId,
              addressId,
              body
            );
            recordAudit({
              actorRole: auth.role,
            actorUserId: auth.userId || "",
              action: "customer.address_update",
              entityType: "shop_customer",
              entityId: customer.customerId,
              detail: { customerId: customer.customerId, addressId },
            });
            sendJson(res, 200, { customer });
          } catch (err) {
            sendJson(res, err.status || 400, { error: err.message });
          }
          return;
        }
      }

      if (method === "GET" && path === "/v1/kitchen-notes") {
        if (!requireAuth(req, res, config)) return;
        const notes = legacyKitchenNotesFromLibrary(config.testTenantId);
        sendJson(res, 200, notes);
        return;
      }

      if (method === "PUT" && path === "/v1/kitchen-notes") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const mods = body.modifiers ?? body.instructionModifiers;
          const tgts = body.targets ?? body.instructionTargets;
          if (Array.isArray(mods)) {
            for (const name of mods) {
              upsertModifier(
                config.testTenantId,
                { name: String(name), isActive: true },
                { role: auth.role }
              );
            }
          }
          if (Array.isArray(tgts)) {
            for (const name of tgts) {
              upsertTarget(
                config.testTenantId,
                { name: String(name), isActive: true },
                { role: auth.role }
              );
            }
          }
          const notes = legacyKitchenNotesFromLibrary(config.testTenantId);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "kitchen.notes.update",
            entityType: "shop_settings",
            entityId: config.testTenantId,
            detail: notes,
          });
          sendJson(res, 200, notes);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/kitchen-library") {
        if (!requireAuth(req, res, config)) return;
        const includeInactive =
          url.searchParams.get("includeInactive") !== "0";
        sendJson(res, 200, {
          library: getKitchenLibrary(config.testTenantId, { includeInactive }),
        });
        return;
      }

      if (method === "PUT" && path === "/v1/kitchen-modifiers") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const modifier = upsertModifier(config.testTenantId, body, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "kitchen.modifier.upsert",
            entityType: "kitchen_modifier",
            entityId: modifier.modifierId,
            detail: { name: modifier.name, isActive: modifier.isActive },
          });
          sendJson(res, 200, { modifier });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/kitchen-targets") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const target = upsertTarget(config.testTenantId, body, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "kitchen.target.upsert",
            entityType: "kitchen_target",
            entityId: target.targetId,
            detail: { name: target.name, isActive: target.isActive },
          });
          sendJson(res, 200, { target });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/kitchen-standalone") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const standalone = upsertStandalone(config.testTenantId, body, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "kitchen.standalone.upsert",
            entityType: "kitchen_standalone",
            entityId: standalone.standaloneId,
            detail: { name: standalone.name, isActive: standalone.isActive },
          });
          sendJson(res, 200, { standalone });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PATCH" && path.startsWith("/v1/kitchen-modifiers/")) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const id = decodeURIComponent(
            path.slice("/v1/kitchen-modifiers/".length)
          );
          const body = await readBody(req);
          const row = setOptionActive(
            "kitchen_modifiers",
            "modifier_id",
            id,
            body.isActive !== false && body.isActive !== 0,
            { role: auth.role }
          );
          sendJson(res, 200, {
            modifier: {
              modifierId: row.modifier_id,
              name: row.name,
              isActive: Boolean(row.is_active),
            },
          });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PATCH" && path.startsWith("/v1/kitchen-targets/")) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const id = decodeURIComponent(
            path.slice("/v1/kitchen-targets/".length)
          );
          const body = await readBody(req);
          const row = setOptionActive(
            "kitchen_targets",
            "target_id",
            id,
            body.isActive !== false && body.isActive !== 0,
            { role: auth.role }
          );
          sendJson(res, 200, {
            target: {
              targetId: row.target_id,
              name: row.name,
              isActive: Boolean(row.is_active),
            },
          });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/addons") {
        if (!requireAuth(req, res, config)) return;
        const includeInactive =
          url.searchParams.get("includeInactive") !== "0";
        const q = url.searchParams.get("q") || "";
        sendJson(res, 200, {
          addons: listAddons(config.testTenantId, { includeInactive, q }),
        });
        return;
      }

      if (method === "GET" && path.startsWith("/v1/addons/")) {
        if (!requireAuth(req, res, config)) return;
        const id = decodeURIComponent(path.slice("/v1/addons/".length));
        if (id.endsWith("/assignments")) {
          const addonId = id.replace(/\/assignments$/, "");
          const addon = getAddon(addonId);
          if (!addon) {
            sendJson(res, 404, { error: "Add-on not found" });
            return;
          }
          sendJson(res, 200, {
            addon,
            assignments: listAddonAssignments(addonId),
          });
          return;
        }
        const addon = getAddon(id);
        if (!addon) {
          sendJson(res, 404, { error: "Add-on not found" });
          return;
        }
        sendJson(res, 200, { addon });
        return;
      }

      if (method === "PUT" && path === "/v1/addons") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const prevId = String(body.addonId || body.id || "");
          const prev = prevId ? getAddon(prevId) : null;
          const addon = upsertAddon(config.testTenantId, body, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "addon.upsert",
            entityType: "addon",
            entityId: addon.addonId,
            detail: {
              name: addon.name,
              priceCents: addon.priceCents,
              isActive: addon.isActive,
              taxApplicable: addon.taxApplicable,
            },
          });
          if (
            prev &&
            Boolean(prev.taxApplicable) !== Boolean(addon.taxApplicable)
          ) {
            recordAudit({
              actorRole: auth.role,
            actorUserId: auth.userId || "",
              action: "addon.tax_applicable",
              entityType: "addon",
              entityId: addon.addonId,
              detail: {
                oldTaxApplicable: Boolean(prev.taxApplicable),
                newTaxApplicable: Boolean(addon.taxApplicable),
              },
            });
          }
          sendJson(res, 200, { addon });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "PUT" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/instructions")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const itemId = decodeURIComponent(
            path.slice("/v1/menu-items/".length, -"/instructions".length)
          );
          const body = await readBody(req);
          const configInstr = setItemInstructionConfig(itemId, body, {
            role: auth.role,
          });
          sendJson(res, 200, { itemId, instructions: configInstr });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "GET" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/instructions")
      ) {
        if (!requireAuth(req, res, config)) return;
        const itemId = decodeURIComponent(
          path.slice("/v1/menu-items/".length, -"/instructions".length)
        );
        const configInstr = getItemInstructionConfig(itemId);
        if (!configInstr) {
          sendJson(res, 404, { error: "Menu item not found" });
          return;
        }
        sendJson(res, 200, { itemId, instructions: configInstr });
        return;
      }

      if (
        method === "PUT" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/addons")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const itemId = decodeURIComponent(
            path.slice("/v1/menu-items/".length, -"/addons".length)
          );
          const body = await readBody(req);
          const assignments = setItemAddons(
            itemId,
            body.assignments || body.addonAssignments || [],
            { role: auth.role }
          );
          sendJson(res, 200, { itemId, addons: assignments });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "GET" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/addons")
      ) {
        if (!requireAuth(req, res, config)) return;
        const itemId = decodeURIComponent(
          path.slice("/v1/menu-items/".length, -"/addons".length)
        );
        if (!getMenuItem(itemId)) {
          sendJson(res, 404, { error: "Menu item not found" });
          return;
        }
        sendJson(res, 200, {
          itemId,
          addons: getItemAddons(itemId, { activeOnly: false }),
        });
        return;
      }

      if (
        method === "GET" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/product-knowledge")
      ) {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        const itemId = decodeURIComponent(
          path.slice("/v1/menu-items/".length, -"/product-knowledge".length)
        );
        const item = getMenuItem(itemId);
        if (!item) {
          sendJson(res, 404, { error: "Menu item not found" });
          return;
        }
        const knowledge = getProductKnowledge(itemId, { role: auth.role });
        const shortDescription = item.description || "";
        sendJson(res, 200, {
          itemId,
          menuItem: {
            itemId: item.item_id,
            name: item.name,
            category: item.category || "",
            subcategory: item.subcategory || "",
            description: shortDescription,
            imageUrl: item.image_url || null,
            image_url: item.image_url || null,
            prepStationId: item.prepStationId || null,
            stationIds: item.stationIds || [],
            hasVariants: Boolean(item.hasVariants),
          },
          productKnowledge: knowledge,
          hasContent: knowledgeHasDisplayContent(knowledge, shortDescription),
        });
        return;
      }

      if (
        method === "PUT" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/product-knowledge")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const itemId = decodeURIComponent(
            path.slice("/v1/menu-items/".length, -"/product-knowledge".length)
          );
          const body = await readBody(req);
          const knowledge = upsertProductKnowledge(itemId, body, {
            role: auth.role,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.product_knowledge",
            entityType: "menu_item",
            entityId: itemId,
            detail: {
              hasQuickAnswer: Boolean(knowledge.salesmanQuickAnswer),
              ingredientCount: knowledge.ingredients?.length || 0,
              allergenVerified: Boolean(knowledge.allergenVerified),
            },
          });
          sendJson(res, 200, { itemId, productKnowledge: knowledge });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/stations") {
        if (!requireAuth(req, res, config)) return;
        sendJson(res, 200, { stations: listStations() });
        return;
      }

      if (method === "GET" && path.startsWith("/v1/stations/")) {
        if (!requireAuth(req, res, config)) return;
        const id = decodeURIComponent(path.slice("/v1/stations/".length));
        const station = getStation(id);
        if (!station) {
          sendJson(res, 404, { error: "Station not found" });
          return;
        }
        sendJson(res, 200, { station });
        return;
      }

      const stationDelete = /^\/v1\/stations\/([^/]+)$/.exec(path);
      if (method === "DELETE" && stationDelete) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const result = removeStation(decodeURIComponent(stationDelete[1]));
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "station.remove",
            entityType: "station",
            entityId: result.stationId,
            detail: { mode: result.mode, name: result.name },
          });
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code, items: err.items } : {}),
          });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/stations") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        const body = await readBody(req);
        // Validate name and create an id for a new station. Names must be unique
        // because menu CSV import matches the preparation center by name.
        const stationName = String(body?.name || "").trim().replace(/\s+/g, " ").toUpperCase();
        if (stationName.length < 2 || stationName.length > 30) {
          sendJson(res, 400, { error: "Station name must be 2–30 characters." });
          return;
        }
        const allStations = listStations();
        let stationId = String(body?.stationId || "").trim();
        if (!stationId) {
          const slug = stationName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
          if (!slug) {
            sendJson(res, 400, { error: "Use letters or numbers in the station name." });
            return;
          }
          // The id can be taken by a station that was later renamed: pick a free one.
          stationId = `station_${slug}`;
          for (let n = 2; allStations.some((s) => s.station_id === stationId); n += 1) {
            stationId = `station_${slug}_${n}`;
          }
        } else if (!allStations.some((s) => s.station_id === stationId)) {
          sendJson(res, 404, { error: "Station not found." });
          return;
        }
        const sameName = allStations.find(
          (s) => s.station_id !== stationId && String(s.name).toUpperCase() === stationName
        );
        if (sameName && !sameName.is_active && !String(body?.stationId || "").trim()) {
          // Adding a name that was removed earlier: bring that station back.
          stationId = sameName.station_id;
        } else if (sameName) {
          sendJson(res, 409, { error: `A station called ${stationName} already exists.` });
          return;
        }
        if (stationId === "station_cashier" && stationName !== "CASHIER") {
          sendJson(res, 400, { error: "The CASHIER station cannot be renamed." });
          return;
        }
        const station = upsertStation({
          stationId,
          name: stationName,
          description: body.description || "",
          isActive: body.isActive !== false,
          printerId: body.printerId || null,
        });
        recordAudit({
          actorRole: auth.role,
            actorUserId: auth.userId || "",
          action: "station.upsert",
          entityType: "station",
          entityId: station.station_id,
          detail: {
            printerId: station.printer_id,
            isActive: station.is_active,
          },
        });
        sendJson(res, 200, { station });
        return;
      }

      if (method === "GET" && path === "/v1/print-settings") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        sendJson(res, 200, {
          settings: getPrintSettings(),
          physicalPrintEnabled: isPhysicalPrintEffectivelyEnabled(config),
          envOverride: envPhysicalPrintOverride(),
        });
        return;
      }

      if (method === "PUT" && path === "/v1/print-settings") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const settings = updatePrintSettings(body || {}, {
            role: auth.role,
            userId: auth.userId || "",
          });
          sendJson(res, 200, {
            settings,
            physicalPrintEnabled: isPhysicalPrintEffectivelyEnabled(config),
            envOverride: envPhysicalPrintOverride(),
          });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/printers") {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        sendJson(res, 200, { printers: printersForRole(listPrinters(), auth) });
        return;
      }

      if (method === "PUT" && path === "/v1/printers") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        const body = await readBody(req);
        try {
          const printer = upsertPrinter({
            printerId: body.printerId,
            displayName: body.displayName,
            connectionType: body.connectionType,
            host: body.host ?? null,
            port: body.port ?? null,
            windowsQueueName: body.windowsQueueName ?? null,
            paperWidthMm: body.paperWidthMm ?? 80,
            capabilities: body.capabilities || {},
            isActive: body.isActive !== false,
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "printer.upsert",
            entityType: "printer",
            entityId: printer.printer_id,
            detail: {
              connectionType: printer.connection_type,
              host: printer.host,
              port: printer.port,
              isActive: printer.is_active,
              physicalDispatchEnabled: Boolean(
                printer.capabilities?.physicalDispatchEnabled
              ),
            },
          });
          sendJson(res, 200, { printer });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "POST" &&
        path.startsWith("/v1/printers/") &&
        path.endsWith("/preview")
      ) {
        if (!requireAuth(req, res, config, ["admin"])) return;
        const id = decodeURIComponent(
          path.slice("/v1/printers/".length, -"/preview".length)
        );
        const printer = getPrinter(id);
        if (!printer) {
          sendJson(res, 404, { error: "Printer not found" });
          return;
        }
        sendJson(res, 200, previewPrinterTicket(printer, config));
        return;
      }

      if (
        method === "POST" &&
        path.startsWith("/v1/printers/") &&
        path.endsWith("/test")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        const id = decodeURIComponent(
          path.slice("/v1/printers/".length, -"/test".length)
        );
        const printer = getPrinter(id);
        if (!printer) {
          sendJson(res, 404, { error: "Printer not found" });
          return;
        }
        const body = await readBody(req).catch(() => ({}));
        let mode = String(body.mode || "preview");
        // Default MOCK printers to mock_file when mode omitted as "test"
        if (!body.mode && printer.connection_type === "MOCK") {
          mode = "mock_file";
        }
        const result = await runPrinterTest({
          printer,
          config,
          mode,
          actorRole: auth.role,
            actorUserId: auth.userId || "",
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (method === "GET" && path === "/v1/audit-events") {
        if (!requireAuth(req, res, config, ["admin"])) return;
        const events = listAuditEvents({
          limit: url.searchParams.get("limit") || 100,
          entityType: url.searchParams.get("entityType") || undefined,
        });
        sendJson(res, 200, { events });
        return;
      }

      if (method === "GET" && path === "/v1/menu-categories") {
        if (!requireAuth(req, res, config)) return;
        const includeInactive =
          url.searchParams.get("includeInactive") !== "0" &&
          url.searchParams.get("includeInactive") !== "false";
        sendJson(res, 200, listCategories({ includeInactive }));
        return;
      }

      if (
        method === "PUT" &&
        (path === "/v1/menu-categories/reorder" || path === "/v1/menu-subcategories/reorder")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const isSub = path === "/v1/menu-subcategories/reorder";
          const result = isSub
            ? reorderSubcategories(body?.categoryId, body?.subcategoryIds)
            : reorderCategories(body?.categoryIds);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: isSub ? "menu.subcategory.reorder" : "menu.category.reorder",
            entityType: isSub ? "menu_subcategory" : "menu_category",
            entityId: isSub ? String(body?.categoryId || "") : "all",
            detail: { count: (isSub ? body?.subcategoryIds : body?.categoryIds)?.length || 0 },
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message || "Could not save the order." });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/menu-categories") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const category = upsertCategory(body);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.category.upsert",
            entityType: "menu_category",
            entityId: category.category_id,
            detail: {
              name: category.name,
              isActive: category.is_active,
            },
          });
          sendJson(res, 200, { category });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "PUT" && path === "/v1/menu-subcategories") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const subcategory = upsertSubcategory(body);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.subcategory.upsert",
            entityType: "menu_subcategory",
            entityId: subcategory.subcategory_id,
            detail: {
              name: subcategory.name,
              categoryId: subcategory.category_id,
              isActive: subcategory.is_active,
            },
          });
          sendJson(res, 200, { subcategory });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/menu-items") {
        if (!requireAuth(req, res, config)) return;
        const includeInactive =
          url.searchParams.get("includeInactive") !== "0" &&
          url.searchParams.get("includeInactive") !== "false";
        const menuItems = listMenuItems({ includeInactive });
        sendJson(res, 200, { menuItems });
        return;
      }

      if (method === "PUT" && path === "/v1/menu-items/reorder") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const itemIds = body.itemIds || body.item_ids || [];
          const menuItems = reorderMenuItems(itemIds);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.reorder",
            entityType: "menu_items",
            entityId: "bulk",
            detail: { count: itemIds.length },
          });
          sendJson(res, 200, { menuItems });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/menu-items/export.csv") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const csv = exportMenuItemsCsv();
          const filename = `menu-items-${new Date()
            .toISOString()
            .slice(0, 10)}.csv`;
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length": Buffer.byteLength(csv),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          });
          res.end(csv);
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path === "/v1/menu-items/import-template.csv") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const csv = exportMenuItemsTemplateCsv();
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="menu-items-template.csv"',
            "Content-Length": Buffer.byteLength(csv),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          });
          res.end(csv);
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message });
        }
        return;
      }

      if (method === "POST" && path === "/v1/menu-items/import") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req, { maxBytes: 4_000_000 });
          const csv = body.csv != null ? String(body.csv) : "";
          if (!csv.trim()) {
            sendJson(res, 400, { error: "csv text is required" });
            return;
          }
          const summary = importMenuItemsCsv(csv);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.bulk_import",
            entityType: "menu_items",
            entityId: "bulk",
            detail: {
              created: summary.created,
              updated: summary.updated,
              variants: summary.variants,
              errorCount: summary.errors.length,
            },
          });
          sendJson(res, summary.errors.length ? 207 : 200, { summary });
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            errors: err.errors,
            summary: err.summary,
          });
        }
        return;
      }

      if (
        method === "PATCH" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/availability")
      ) {
        // Device may toggle sold-out; only admin may change active/inactive.
        const auth = requireAuth(req, res, config, ["admin", "device", "cashier"]);
        if (!auth || forbidUnless(auth, res, "menu.sold_out.update")) return;
        const id = decodeURIComponent(
          path.slice("/v1/menu-items/".length, -"/availability".length)
        );
        try {
          const body = await readBody(req);
          const item = updateMenuItemAvailability(
            id,
            {
              isActive: body.isActive,
              isSoldOut: body.isSoldOut,
            },
            { role: auth.role }
          );
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.availability",
            entityType: "menu_item",
            entityId: id,
            detail: {
              isActive: item.is_active,
              isSoldOut: item.is_sold_out,
            },
          });
          sendJson(res, 200, { menuItem: item });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "GET" &&
        path.startsWith("/v1/menu-items/") &&
        !path.endsWith("/image") &&
        !path.endsWith("/availability") &&
        !path.endsWith("/instructions") &&
        !path.endsWith("/addons") &&
        !path.endsWith("/product-knowledge") &&
        !path.includes("/image/") &&
        path.slice("/v1/menu-items/".length).indexOf("/") === -1
      ) {
        if (!requireAuth(req, res, config)) return;
        const id = decodeURIComponent(path.slice("/v1/menu-items/".length));
        const item = getMenuItem(id);
        if (!item) {
          sendJson(res, 404, { error: "Menu item not found" });
          return;
        }
        sendJson(res, 200, { menuItem: item });
        return;
      }

      if (method === "PUT" && path === "/v1/menu-items") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const prevId = String(body.itemId || body.item_id || "");
          const prev = prevId ? getMenuItem(prevId) : null;
          const item = upsertMenuItem(body);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.upsert",
            entityType: "menu_item",
            entityId: item.item_id,
            detail: {
              name: item.name,
              sku: item.sku,
              category: item.category,
              isActive: item.is_active,
              isSoldOut: item.is_sold_out,
              taxApplicable: item.taxApplicable,
              stationIds: item.stationIds,
            },
          });
          if (
            prev &&
            Boolean(prev.taxApplicable) !== Boolean(item.taxApplicable)
          ) {
            recordAudit({
              actorRole: auth.role,
            actorUserId: auth.userId || "",
              action: "menu.tax_applicable",
              entityType: "menu_item",
              entityId: item.item_id,
              detail: {
                oldTaxApplicable: Boolean(prev.taxApplicable),
                newTaxApplicable: Boolean(item.taxApplicable),
              },
            });
          }
          sendJson(res, 200, { menuItem: item });
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            errors: err.errors,
          });
        }
        return;
      }

      if (
        method === "POST" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/image")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        const id = decodeURIComponent(
          path.slice("/v1/menu-items/".length, -"/image".length)
        );
        try {
          const body = await readBody(req, { maxBytes: 6_000_000 });
          const item = saveMenuItemImage(
            id,
            { mimeType: body.mimeType, base64Data: body.base64Data },
            config
          );
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.image.upload",
            entityType: "menu_item",
            entityId: id,
            detail: { imageFilename: item.image_filename },
          });
          sendJson(res, 200, { menuItem: item });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "DELETE" &&
        path.startsWith("/v1/menu-items/") &&
        path.endsWith("/image")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        const id = decodeURIComponent(
          path.slice("/v1/menu-items/".length, -"/image".length)
        );
        try {
          const item = clearMenuItemImage(id, config);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "menu.image.clear",
            entityType: "menu_item",
            entityId: id,
            detail: {},
          });
          sendJson(res, 200, { menuItem: item });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        (method === "POST" || method === "DELETE") &&
        path.startsWith("/v1/menu-subcategories/") &&
        path.endsWith("/image")
      ) {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        const id = decodeURIComponent(
          path.slice("/v1/menu-subcategories/".length, -"/image".length)
        );
        try {
          if (method === "POST") {
            const body = await readBody(req, { maxBytes: 6_000_000 });
            saveSubcategoryImage(id, { base64Data: body.base64Data }, config);
          } else {
            clearSubcategoryImage(id, config);
          }
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: method === "POST" ? "menu.subcategory.image.upload" : "menu.subcategory.image.clear",
            entityType: "menu_subcategory",
            entityId: id,
            detail: {},
          });
          sendJson(res, 200, listCategories({ includeInactive: true }));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "GET" && path.startsWith("/v1/menu-images/")) {
        // Same-origin session or bearer — images must be shareable across restaurant devices
        // via the local server, not browser-only storage.
        if (!requireAuth(req, res, config)) return;
        const filename = decodeURIComponent(
          path.slice("/v1/menu-images/".length)
        );
        const filePath = resolveMenuImagePath(filename, config);
        if (!filePath) {
          sendJson(res, 404, { error: "Image not found" });
          return;
        }
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": contentTypeForImage(filePath),
          "Content-Length": body.length,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=3600",
        });
        res.end(body);
        return;
      }

      if (method === "POST" && path === "/v1/order-numbers") {
        const auth = requireAuth(req, res, config);
        if (!auth || forbidUnless(auth, res, "sales.order.create")) return;
        try {
          const orderNumber = peekNextOrderNumber(config.testTenantId);
          sendJson(res, 200, { orderNumber });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (method === "POST" && path === "/v1/test-orders") {
        const auth = requireAuth(req, res, config);
        if (!auth || forbidUnless(auth, res, "sales.order.create")) return;
        try {
          const body = await readBody(req);
          if (body.tenantId && body.tenantId !== config.testTenantId) {
            sendJson(res, 403, {
              error: "tenantId is not allowed for this server instance",
            });
            return;
          }
          const result = createTestOrder(body, config, {
            role: auth.role,
            deviceId: auth.deviceId || "",
            userId: auth.userId || "",
            permissions: auth.staff ? auth.permissions || [] : null,
            terminalId: auth.terminalId || "",
            terminalName: auth.terminalName || "",
          });
          sendJson(res, result.created ? 201 : 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.configuredChargeCents != null
              ? { configuredChargeCents: err.configuredChargeCents }
              : {}),
            ...(err.blockNumber ? { blockNumber: err.blockNumber } : {}),
          });
        }
        return;
      }

      if (method === "GET" && path === "/v1/test-orders/summary") {
        if (!requireAuth(req, res, config)) return;
        const counts = countOrders(config.testTenantId);
        sendJson(res, 200, {
          tenantId: config.testTenantId,
          orderCount: counts.total,
          testOrderCount: counts.testCount,
          currencyLockedByOrders: counts.total > 0,
        });
        return;
      }

      if (method === "DELETE" && path === "/v1/test-orders") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const result = clearTestOrders(config.testTenantId, {
            role: auth.role,
            confirm: Boolean(body.confirm),
          });
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "orders.test.clear",
            entityType: "orders",
            entityId: config.testTenantId,
            detail: {
              deleted: result.deleted,
              remainingOrders: result.remainingOrders,
            },
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (method === "GET" && path === "/v1/admin/data-cleaning/summary") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          sendJson(res, 200, getDataCleaningSummary(config.testTenantId));
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (method === "POST" && path === "/v1/admin/data-cleaning") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const body = await readBody(req);
          const result = runDataCleaning(config.testTenantId, {
            role: auth.role,
            scope: body.scope,
            confirm: Boolean(body.confirm),
            confirmPhrase: body.confirmPhrase,
            actorUserId: auth.userId || "",
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (
        (path === "/v1/bank-accounts" && (method === "GET" || method === "POST")) ||
        (method === "PUT" && path.startsWith("/v1/bank-accounts/"))
      ) {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        const manage = url.searchParams.get("manage") === "1" || method !== "GET";
        const allowed = manage
          ? auth.userId && authAllows(auth, "shop.bank_accounts.manage")
          : auth.userId &&
            (authAllows(auth, "sales.payment.receive") || authAllows(auth, "shop.bank_accounts.manage"));
        if (!allowed) {
          if (method !== "GET") {
            recordAudit({
              actorRole: auth.role || "",
              actorUserId: auth.userId || "",
              action: "bank_account.reject",
              entityType: "shop_bank_account",
              entityId: "",
              detail: { code: "FORBIDDEN", shopId: config.testTenantId },
            });
          }
          sendJson(res, 403, { error: "You do not have permission for this action." });
          return;
        }
        try {
          if (method === "GET" && manage) {
            sendJson(res, 200, { accounts: listManagedBankAccounts(config.testTenantId) });
            return;
          }
          if (method === "GET") {
            sendJson(res, 200, { accounts: listSalesBankAccounts(config.testTenantId) });
            return;
          }
          const body = await readBody(req);
          if (method === "POST") {
            sendJson(res, 201, { account: createBankAccount(config.testTenantId, body, auth) });
            return;
          }
          const accountId = decodeURIComponent(path.slice("/v1/bank-accounts/".length));
          if (!accountId || accountId.includes("/")) {
            sendJson(res, 404, { error: "Bank account not found.", code: "BANK_ACCOUNT_NOT_FOUND" });
            return;
          }
          sendJson(res, 200, {
            account: updateBankAccount(config.testTenantId, accountId, body, auth),
          });
        } catch (err) {
          const safe = toPublicBankError(err);
          sendJson(res, safe.status || 400, {
            error: safe.message,
            ...(safe.code ? { code: safe.code } : {}),
          });
        }
        return;
      }

      // P2-E1.1 TEST-only shift/date + token identity. No financial day-end.
      if (path === '/v1/business-shift' && method === 'GET') {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        if (
          !auth.userId ||
          !(
            authAllows(auth, "sales.orders.view") ||
            authAllows(auth, "sales.order.create") ||
            authAllows(auth, "sales.payment.receive")
          )
        ) {
          sendJson(res, 403, { error: "Sales permission required to view the business shift." });
          return;
        }
        try { sendJson(res, 200, getBusinessShift(config.testTenantId)); }
        catch (err) { sendJson(res, err.status || 400, { error: err.message, code: err.code }); }
        return;
      }
      if (path === '/v1/business-shift/open' && method === 'POST') {
        const auth = requireAuth(req, res, config, ['admin']);
        if (!auth) return;
        if (!auth.userId) { sendJson(res, 403, { error: 'Admin login required.' }); return; }
        try {
          const body = await readBody(req);
          const shift = openBusinessShift(config.testTenantId, body.businessDate, auth);
          // Push the new POS business date to riders without waiting for the bridge loop.
          resetCloudBridgeBackoff();
          void syncCloudDeliveryBridge(config.testTenantId, config).catch(() => {});
          sendJson(res, 201, { shift });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message, code: err.code }); }
        return;
      }
      if (path === '/v1/business-shift/close' && method === 'POST') {
        const auth = requireAuth(req, res, config, ['admin']);
        if (!auth) return;
        if (!auth.userId) { sendJson(res, 403, { error: 'Admin login required.' }); return; }
        try {
          const body = await readBody(req);
          const shift = closeBusinessShift(config.testTenantId, body.shiftId, auth, body.confirm === true);
          resetCloudBridgeBackoff();
          void syncCloudDeliveryBridge(config.testTenantId, config).catch(() => {});
          sendJson(res, 200, { shift });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message, code: err.code }); }
        return;
      }

      if (method === "GET" && (path === "/v1/order-register" || path.startsWith("/v1/order-register/"))) {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        if (!auth.userId || !authAllows(auth, "sales.orders.view")) {
          sendJson(res, 403, { error: "You do not have permission for this action." });
          return;
        }
        try {
          if (path === "/v1/order-register") {
            sendJson(res, 200, listOrderRegister(config.testTenantId, url.searchParams));
            return;
          }
          const orderId = decodeURIComponent(path.slice("/v1/order-register/".length));
          if (!orderId || orderId.includes("/")) {
            sendJson(res, 404, { error: "Order not found." });
            return;
          }
          sendJson(res, 200, { order: getOrderRegisterDetail(config.testTenantId, orderId) });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message || "Could not load orders." });
        }
        return;
      }

      // P2-E2A: Authenticated TEST Delivery Boy pool; no cloud exposure or money writes.
      if (path === '/v1/delivery-pool' && method === 'GET') {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.pool.view')) return;
        try {
          sendJson(res, 200, listAvailableDeliveries(config.testTenantId, auth, {
            block: url.searchParams.get('block') || '', road: url.searchParams.get('road') || '',
          }));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }
      if (path === '/v1/delivery-pool/mine' && method === 'GET') {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.pool.view')) return;
        try { sendJson(res, 200, listMyDeliveries(config.testTenantId, auth)); }
        catch (err) { sendJson(res, err.status || 400, { error: err.message, code: err.code }); }
        return;
      }
      // P2-E2B: suggestions require an already-claimed order owned by this driver.
      if (path === '/v1/delivery-pool/suggestions' && method === 'GET') {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.pool.view')) return;
        try {
          sendJson(res, 200, listRouteSuggestions(
            config.testTenantId, auth, url.searchParams.get('orderId') || ''));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }
      const deliveryBillMatch = path.match(/^\/v1\/delivery-pool\/([^/]+)\/bill$/);
      if (method === 'GET' && deliveryBillMatch) {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.pool.view')) return;
        try {
          const id = decodeURIComponent(deliveryBillMatch[1]);
          sendJson(res, 200, { bill: getDeliveryBill(config.testTenantId, id, auth) });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }
      const acceptDeliveryMatch = path.match(/^\/v1\/delivery-pool\/([^/]+)\/accept$/);
      if (method === 'POST' && acceptDeliveryMatch) {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.pool.accept')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res, 403, { error: 'Shop mismatch.', code: 'SHOP_MISMATCH' }); return;
          }
          const id = decodeURIComponent(acceptDeliveryMatch[1]);
          sendJson(res, 200, acceptAvailableDelivery(
            config.testTenantId, id, body.expectedRevision, auth));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }

      // P2-E2C0: Rider payment OBSERVATION only. No shop ledger or credit posting.
      const deliveryPayMatch = path.match(/^\/v1\/delivery-pool\/([^/]+)\/payment-report$/);
      if (method === 'POST' && deliveryPayMatch) {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.payment.report')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res, 403, { error: 'Shop mismatch.', code: 'SHOP_MISMATCH' }); return;
          }
          const id = decodeURIComponent(deliveryPayMatch[1]);
          sendJson(res, 200, markDeliveryPayment(
            config.testTenantId, id, body.reportType, body.expectedVersion, auth));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, code: err.code });
        }
        return;
      }

      // P2-E2C1: Delivery status and shop credit decisions. No accounting writes.
      const deliveryStatusMatch = path.match(/^\/v1\/delivery-pool\/([^/]+)\/status$/);
      if (method === 'POST' && deliveryStatusMatch) {
        const auth = requireAuth(req, res, config, ['delivery']);
        if (!auth || forbidUnless(auth, res, 'delivery.status.update')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res, 403, {error:'Shop mismatch.',code:'SHOP_MISMATCH'}); return;
          }
          sendJson(res, 200, markDeliveryLifecycle(config.testTenantId,
            decodeURIComponent(deliveryStatusMatch[1]), body.action,
            body.expectedVersion, body.reason || '', auth));
        } catch(err) { sendJson(res, err.status || 400, {error:err.message,code:err.code}); }
        return;
      }
      const deliveryCancelMatch = path.match(/^\/v1\/delivery-review\/([^/]+)\/cancellation$/);
      if (method === 'POST' && deliveryCancelMatch) {
        const auth = requireAuth(req, res, config, ['admin','cashier']);
        if (!auth || forbidUnless(auth, res, 'sales.orders.view')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;
          }
          sendJson(res,200,shopReviewDeliveryCancellation(config.testTenantId,
            decodeURIComponent(deliveryCancelMatch[1]),body.action,body.expectedVersion,auth));
        } catch(err) { sendJson(res,err.status || 400,{error:err.message,code:err.code}); }
        return;
      }
      const deliveryCreditMatch = path.match(/^\/v1\/delivery-review\/([^/]+)\/credit$/);
      if (method === 'POST' && deliveryCreditMatch) {
        const auth = requireAuth(req, res, config, ['admin','cashier']);
        if (!auth || forbidUnless(auth, res, 'sales.orders.view')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;
          }
          sendJson(res,200,reviewDeliveryCredit(config.testTenantId,
            decodeURIComponent(deliveryCreditMatch[1]),body.reportVersion,
            body.decision,body.note || '',auth));
        } catch(err) { sendJson(res,err.status || 400,{error:err.message,code:err.code}); }
        return;
      }

      // Rider asked to give back an accepted order: cashier/admin allows or refuses.
      const releaseMatch = path.match(/^\/v1\/delivery-review\/([^/]+)\/release$/);
      if (method === 'POST' && releaseMatch) {
        const auth = requireAuth(req, res, config, ['admin','cashier']);
        if (!auth) return;
        if (!auth.userId || !authAllows(auth,'sales.orders.view')) {
          sendJson(res,403,{error:'Cashier/Admin permission required.'}); return;
        }
        try {
          const body = await readBody(req);
          const orderId = decodeURIComponent(releaseMatch[1]);
          const result = decideReleaseRequest(config.testTenantId, orderId, body, auth);
          sendJson(res,200,{ ok:true, ...result });
        } catch(err) { sendJson(res,err.status || 400,{error:err.message,code:err.code}); }
        return;
      }

      // Rider multiple payment: cashier confirms the shop-paid part, approves/rejects credit.
      const splitReviewMatch = path.match(/^\/v1\/delivery-review\/([^/]+)\/split$/);
      if (method === 'POST' && splitReviewMatch) {
        const auth = requireAuth(req, res, config, ['admin','cashier']);
        if (!auth) return;
        if (!auth.userId || !authAllows(auth,'sales.payment.receive')) {
          sendJson(res,403,{error:'Cashier/Admin payment permission required.'}); return;
        }
        try {
          const body = await readBody(req);
          const orderId = decodeURIComponent(splitReviewMatch[1]);
          const action = String(body.action || '');
          const result = action === 'CONFIRM_SHOP_PAID'
            ? confirmSplitShopPaid(config.testTenantId, orderId, body, auth)
            : action === 'APPROVE_CREDIT'
              ? approveSplitCredit(config.testTenantId, orderId, body, auth)
              : action === 'REJECT_CREDIT'
                ? rejectSplitCredit(config.testTenantId, orderId, body, auth)
                : null;
          if (!result) { sendJson(res,400,{error:'Unknown action.',code:'INVALID_ACTION'}); return; }
          sendJson(res,200,{ ok:true, review: readSplitReview(getDb(), config.testTenantId, orderId) });
        } catch(err) { sendJson(res,err.status || 400,{error:err.message,code:err.code}); }
        return;
      }

      // P2-E2C2: Cashier/Admin originated credit: authoritative status, not ledger posting.
      const shopDirectCreditMatch = path.match(/^\/v1\/delivery-review\/([^/]+)\/shop-credit$/);
      if (method === 'POST' && shopDirectCreditMatch) {
        const auth = requireAuth(req, res, config, ['admin','cashier']);
        if (!auth || forbidUnless(auth,res,'sales.orders.view')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'}); return;
          }
          sendJson(res,200,shopSetDirectCredit(config.testTenantId,
            decodeURIComponent(shopDirectCreditMatch[1]),body.action,
            body.expectedVersion,body.note || '',auth));
        } catch(err) {sendJson(res,err.status || 400,{error:err.message,code:err.code});}
        return;
      }

      // P2-E1: TEST-only order status monitoring; no delivery cash ledger writes.
      if (method === 'GET' && (path === '/v1/order-monitor' || path.startsWith('/v1/order-monitor/'))) {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        if (!auth.userId || !authAllows(auth, 'sales.orders.view')) {
          sendJson(res, 403, { error: 'Order monitoring permission required.' });
          return;
        }
        try {
          if (path === '/v1/order-monitor') {
            sendJson(res, 200, listOrderMonitor(config.testTenantId, url.searchParams));
          } else {
            const id = decodeURIComponent(path.slice('/v1/order-monitor/'.length));
            if (!id || id.includes('/')) {
              sendJson(res, 404, { error: 'Order not found.' });
              return;
            }
            sendJson(res, 200, { order: getOrderMonitorDetail(config.testTenantId, id) });
          }
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        }
        return;
      }

      const readyMatch = path.match(/^\/v1\/order-monitor\/([^/]+)\/ready$/);
      if (method === 'POST' && readyMatch) {
        const auth = requireAuth(req, res, config, ['admin', 'cashier']);
        if (!auth) return;
        if (!auth.userId || forbidUnless(auth, res, 'sales.orders.dispatch')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res, 403, { error: 'Shop mismatch.' });
            return;
          }
          const id = decodeURIComponent(readyMatch[1]);
          sendJson(res, 200, markOrderReadyForDelivery(config.testTenantId, id, body.expectedRevision, auth));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        }
        return;
      }

      const unreadyMatch = path.match(/^\/v1\/order-monitor\/([^/]+)\/unready$/);
      if (method === 'POST' && unreadyMatch) {
        const auth = requireAuth(req, res, config, ['admin', 'cashier']);
        if (!auth) return;
        if (!auth.userId || forbidUnless(auth, res, 'sales.orders.dispatch')) return;
        try {
          const body = await readBody(req);
          if (body.shopId && body.shopId !== config.testTenantId) {
            sendJson(res, 403, { error: 'Shop mismatch.' });
            return;
          }
          const id = decodeURIComponent(unreadyMatch[1]);
          sendJson(res, 200, unmarkOrderReadyForDelivery(config.testTenantId, id, body.expectedRevision, auth));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        }
        return;
      }

      if (method === "GET" && path === "/v1/prep-board") {
        const auth = requireAuth(req, res, config, ["admin", "cashier", "kitchen"]);
        if (!auth || forbidUnless(auth, res, "prep.station.work")) return;
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const stationIds = auth.role === "kitchen"
            ? listKitchenStationIds(config.testTenantId, auth.userId) : null;
          const stationId = url.searchParams.get("stationId") || "";
          if (stationIds && stationId && !stationIds.includes(stationId)) {
            sendJson(res, 403, { error: "This preparation station is not assigned to you." });
            return;
          }
          sendJson(res, 200, listPrepBoard(config.testTenantId, stationId, stationIds));
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (
        method === "POST" &&
        (path === "/v1/prep-board/accept" || path === "/v1/prep-board/finish")
      ) {
        const auth = requireAuth(req, res, config, ["admin", "cashier", "kitchen"]);
        if (!auth || forbidUnless(auth, res, "prep.station.work")) return;
        try {
          const body = await readBody(req);
          if (auth.role === "kitchen" &&
              !listKitchenStationIds(config.testTenantId, auth.userId).includes(body.stationId)) {
            sendJson(res, 403, { error: "This preparation station is not assigned to you." });
            return;
          }
          const result = setPrepStatus(
            config.testTenantId,
            body.orderId,
            body.stationId,
            path.endsWith("/finish") ? "FINISHED" : "ACCEPTED",
            auth.userId || "",
            body.expectedStatus,
            body.expectedRevision,
            auth.role || ""
          );
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      const editDraftMatch = path.match(/^\/v1\/orders\/([^/]+)\/edit-draft$/);
      if (method === "GET" && editDraftMatch) {
        const auth = requireAuth(req, res, config);
        if (!auth || forbidUnless(auth, res, "sales.order.create")) return;
        try {
          const draft = loadOrderForEdit(
            config.testTenantId,
            decodeURIComponent(editDraftMatch[1])
          );
          sendJson(res, 200, draft);
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      // P2-E3C1: TEST ONLY rider policy configuration and provisional READ-ONLY daily estimate.
      // Only Staff Admin; no commission payout, accrual or adjustment to cash allocation.
      if (path === '/v1/delivery-commissions' && method === 'GET') {
        if (config.operatingMode !== 'TEST') { sendJson(res,403,{error:'TEST only.'});return; }
        const auth=requireStaffAdmin(req,res,config); if(!auth)return;
        try {sendJson(res,200,listCommissionSettings(config.testTenantId,auth));}
        catch(err){sendJson(res,err.status||400,{error:err.message,code:err.code});}
        return;
      }
      const commissionPolicyRoute=path.match(/^\/v1\/delivery-commissions\/([^/]+)\/policy$/);
      if(commissionPolicyRoute && method==='POST') {
        if(config.operatingMode!=='TEST'){sendJson(res,403,{error:'TEST only.'});return;}
        const auth=requireStaffAdmin(req,res,config);if(!auth)return;
        try {
          const body=await readBody(req);
          if(body.shopId && body.shopId!==config.testTenantId) {sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;}
          const result=saveCommissionSetting(config.testTenantId,decodeURIComponent(commissionPolicyRoute[1]),body,auth);
          sendJson(res,result.replayed?200:201,result);
        }catch(err){sendJson(res,err.status||400,{error:err.message,code:err.code});}
        return;
      }
      const commissionPreviewRoute=path.match(/^\/v1\/delivery-commissions\/([^/]+)\/preview$/);
      if(commissionPreviewRoute && method==='GET') {
        if(config.operatingMode!=='TEST'){sendJson(res,403,{error:'TEST only.'});return;}
        const auth=requireStaffAdmin(req,res,config);if(!auth)return;
        try {
          sendJson(res,200,commissionPreview(config.testTenantId,decodeURIComponent(commissionPreviewRoute[1]),
            url.searchParams.get('businessDate')||'',auth));
        }catch(err){sendJson(res,err.status||400,{error:err.message,code:err.code});}
        return;
      }

      // P2-E3C3: separate TEST-only commission accrual subledger. NEVER shop cash or POS sales.
      const commissionAccountingRoute = path.match(/^\/v1\/delivery-commissions\/([^/]+)\/(closing-preview|accruals)$/);
      if (commissionAccountingRoute && ['GET','POST'].includes(method)) {
        if (config.operatingMode !== 'TEST') { sendJson(res,403,{error:'TEST only.',code:'TEST_ONLY'});return; }
        const auth=requireStaffAdmin(req,res,config); if(!auth)return;
        try {
          const rider=decodeURIComponent(commissionAccountingRoute[1]);
          const action=commissionAccountingRoute[2];
          if(action==='closing-preview'&&method==='GET'){
            sendJson(res,200,previewCommissionAccrual(config.testTenantId,rider,
              url.searchParams.get('businessDate')||'',auth));
          }else if(action==='accruals'&&method==='GET'){
            sendJson(res,200,listCommissionAccruals(config.testTenantId,rider,auth));
          }else if(action==='accruals'&&method==='POST'){
            const body=await readBody(req);
            if(body.shopId&&body.shopId!==config.testTenantId){
              sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;
            }
            const result=approveCommissionAccrual(config.testTenantId,rider,body,auth);
            sendJson(res,result.replayed?200:201,result);
          }else {sendJson(res,405,{error:'Method not allowed.'});}
        }catch(err){sendJson(res,err.status||400,{error:err.message,code:err.code});}
        return;
      }

      // P2-E3D1 TEST-only: append-only correction of cash/bank classification.
      const tenderCorrectionRoute=path.match(/^\/v1\/delivery-rider-settlements\/([^/]+)\/correct-tender$/);
      if (tenderCorrectionRoute && method==='POST') {
        if(config.operatingMode!=='TEST'){
          sendJson(res,403,{error:'TEST only.',code:'TEST_ONLY'});return;
        }
        const auth=requireStaffAdmin(req,res,config);if(!auth)return;
        if(!auth.permissions?.includes('sales.payment.receive')){
          sendJson(res,403,{error:'Payment permission required.',code:'FORBIDDEN'});return;
        }
        try {
          const id=decodeURIComponent(tenderCorrectionRoute[1]);
          const body=await readBody(req);
          if(body.shopId&&body.shopId!==config.testTenantId){
            sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;
          }
          const response=correctRiderSettlementTender(config.testTenantId,id,body,auth);
          sendJson(res,response.replayed?200:201,response);
        }catch(err){
          const safe=toPublicSettlementError(err);
          sendJson(res,safe.status||400,{error:safe.message,code:safe.code||'TENDER_CORRECTION_ERROR'});
        }
        return;
      }

      // P2-E3C4 TEST-only: gross customer cash vs net physical rider settlement.
      if (path === '/v1/delivery-rider-settlements' && ['GET','POST'].includes(method)) {
        if (config.operatingMode !== 'TEST') {
          sendJson(res,403,{error:'TEST only.',code:'TEST_ONLY'});return;
        }
        const auth=requireStaffAdmin(req,res,config);if(!auth)return;
        if(!auth.permissions?.includes('sales.payment.receive')){
          sendJson(res,403,{error:'Payment permission required.',code:'FORBIDDEN'});return;
        }
        try {
          if(method==='GET'){
            sendJson(res,200,listRiderNetSettlements(config.testTenantId,auth,
              url.searchParams.get('riderUserId')||'',url.searchParams.get('businessDate')||'',
              url.searchParams.get('dateFrom')||'',url.searchParams.get('dateTo')||''));
          }else{
            const body=await readBody(req);
            if(body.shopId && body.shopId!==config.testTenantId){
              sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;
            }
            const result=confirmRiderNetSettlement(config.testTenantId,body,auth);
            sendJson(res,result.replayed?200:201,result);
          }
        }catch(err){
          const safe=toPublicSettlementError(err);
          sendJson(res,safe.status||400,{error:safe.message,code:safe.code||'SETTLEMENT_ERROR'});
        }
        return;
      }

      // P2-E3B: cashier-confirmed full cash handover from rider custody (TEST ONLY).
      if (path === '/v1/delivery-cash-handovers' && method === 'GET') {
        if (config.operatingMode !== 'TEST') {
          sendJson(res,403,{error:'Delivery cash handover is TEST-only.'}); return;
        }
        const auth = requireAuth(req,res,config,['admin','cashier']);
        if (!auth || forbidUnless(auth,res,'sales.payment.receive')) return;
        try {
          sendJson(res,200,listDeliveryCashHandovers(config.testTenantId,auth));
        } catch(err) {
          const safe=toPublicSettlementError(err);
          sendJson(res,safe.status || 400,{error:safe.message,...(safe.code?{code:safe.code}:{})});
        }
        return;
      }
      const riderHandoverMatch = path.match(/^\/v1\/delivery-cash-handovers\/([^/]+)\/confirm$/);
      if (riderHandoverMatch && method === 'POST') {
        if (config.operatingMode !== 'TEST') {
          sendJson(res,403,{error:'Delivery cash handover is TEST-only.'}); return;
        }
        const auth = requireAuth(req,res,config,['admin','cashier']);
        if (!auth || forbidUnless(auth,res,'sales.payment.receive')) return;
        try {
          const body=await readBody(req);
          if (body.shopId && body.shopId!==config.testTenantId) {
            sendJson(res,403,{error:'Shop mismatch.',code:'SHOP_MISMATCH'});return;
          }
          const result=confirmDeliveryCashHandover(config.testTenantId,
            decodeURIComponent(riderHandoverMatch[1]),body,auth);
          sendJson(res,result.created?201:200,result);
        } catch(err) {
          const safe=toPublicSettlementError(err);
          sendJson(res,safe.status || 400,{error:safe.message,...(safe.code?{code:safe.code}:{})});
        }
        return;
      }

      // P2-E2C3A TEST-only split cash/bank/credit allocation.
      const allocationRoute = path.match(/^\/v1\/orders\/([^/]+)\/payment-allocations$/);
      if (allocationRoute && (method === 'GET' || method === 'POST')) {
        if (config.operatingMode !== 'TEST') {
          sendJson(res,403,{error:'Split allocations are currently TEST-only.'});return;
        }
        const auth = requireAuth(req,res,config);
        if (!auth) return;
        if (!auth.userId || !authAllows(auth,'sales.payment.receive') ||
          !['admin','cashier'].includes(auth.role)) {
          sendJson(res,403,{error:'Cashier/Admin payment permission required.'});return;
        }
        const orderId=decodeURIComponent(allocationRoute[1]);
        try {
          if (method==='GET') sendJson(res,200,listPaymentAllocations(config.testTenantId,orderId));
          else {
            const body=await readBody(req);
            const result=recordPaymentAllocation(config.testTenantId,orderId,body,auth);
            sendJson(res,result.created?201:200,result);
          }
        } catch(err) {
          const safe=toPublicSettlementError(err);
          sendJson(res,safe.status || 400,{error:safe.message,...(safe.code?{code:safe.code}:{})});
        }
        return;
      }

      if (method === "GET" && path === "/v1/pending-payments") {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        if (!auth.userId || !authAllows(auth, "sales.payment.receive")) {
          sendJson(res, 403, { error: "You do not have permission for this action." });
          return;
        }
        sendJson(res, 200, { orders: listPendingPayments(config.testTenantId) });
        return;
      }

      if (method === "GET" && path === "/v1/reports/shifts") {
        const auth = requireAuth(req, res, config, ["admin", "cashier"]);
        if (!auth) return;
        if (
          !auth.staff ||
          !(
            auth.role === "admin" ||
            authAllows(auth, "sales.orders.view") ||
            authAllows(auth, "sales.payment.receive")
          )
        ) {
          sendJson(res, 403, { error: "You do not have permission for reports." });
          return;
        }
        sendJson(res, 200, { shifts: listReportShifts(config.testTenantId) });
        return;
      }

      if (method === "GET" && path === "/v1/reports/summary") {
        const auth = requireAuth(req, res, config, ["admin", "cashier"]);
        if (!auth) return;
        if (
          !auth.staff ||
          !(
            auth.role === "admin" ||
            authAllows(auth, "sales.orders.view") ||
            authAllows(auth, "sales.payment.receive")
          )
        ) {
          sendJson(res, 403, { error: "You do not have permission for reports." });
          return;
        }
        try {
          const report = getShopReports(config.testTenantId, {
            from: url.searchParams.get("from") || "",
            to: url.searchParams.get("to") || "",
            shiftId: url.searchParams.get("shiftId") || "",
          });
          if (auth.role !== "admin") {
            delete report.items;
            delete report.categories;
            delete report.byOrderType;
            delete report.stations;
            delete report.hourly;
            delete report.opsAudit;
            delete report.riderCash;
            delete report.commission;
            delete report.deliveryMix;
          }
          sendJson(res, 200, { report });
        } catch (err) {
          sendJson(res, err.status || 400, {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (
        (method === "GET" || method === "POST") &&
        path.startsWith("/v1/orders/") &&
        path.endsWith("/settlements")
      ) {
        const auth = requireAuth(req, res, config);
        if (!auth) return;
        const orderId = decodeURIComponent(
          path.slice("/v1/orders/".length, -"/settlements".length)
        );
        if (!auth.userId || !authAllows(auth, "sales.payment.receive")) {
          if (method === "POST") {
            recordAudit({
              actorRole: auth.role || "",
              actorUserId: auth.userId || "",
              action: "payment.cash.reject",
              entityType: "order",
              entityId: orderId,
              detail: { code: "FORBIDDEN", shopId: config.testTenantId, orderId },
            });
          }
          sendJson(res, 403, { error: "You do not have permission for this action." });
          return;
        }
        if (method === "GET") {
          try {
            sendJson(res, 200, getOrderPayment(orderId, config.testTenantId));
          } catch (err) {
            const safe = toPublicSettlementError(err);
            sendJson(res, safe.status || 400, {
              error: safe.message,
              ...(safe.code ? { code: safe.code } : {}),
            });
          }
          return;
        }
        try {
          const body = await readBody(req);
          const result = settleCashPayment(
            { ...body, orderId },
            config,
            { role: auth.role, userId: auth.userId || "" }
          );
          sendJson(res, result.created ? 201 : 200, result);
        } catch (err) {
          const safe = toPublicSettlementError(err);
          sendJson(res, safe.status || 400, {
            error: safe.message,
            ...(safe.code ? { code: safe.code } : {}),
          });
        }
        return;
      }

      // P2-E2E: ADMIN-only TEST invoice void, not delivery cancellation or a refund.
      const invoiceVoidMatch = path.match(/^\/v1\/orders\/([^/]+)\/void$/);
      if (method === 'POST' && invoiceVoidMatch) {
        const auth = requireAuth(req, res, config, ['admin']);
        if (!auth) return;
        if (!auth.userId || auth.role !== 'admin' || !authAllows(auth, 'sales.orders.view')) {
          sendJson(res, 403, { error: 'Admin permission required to void invoices.' });
          return;
        }
        try {
          const body = await readBody(req);
          const orderId = decodeURIComponent(invoiceVoidMatch[1]);
          sendJson(res, 200, voidUnpaidTestOrder(config.testTenantId, orderId, body, auth));
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message || 'Could not void invoice.',
            ...(err.code ? { code: err.code } : {}) });
        }
        return;
      }

      if (method === "GET" && path.startsWith("/v1/orders/")) {
        if (!requireAuth(req, res, config)) return;
        const id = decodeURIComponent(path.slice("/v1/orders/".length));
        const order = getOrder(id);
        if (!order) {
          sendJson(res, 404, { error: "Order not found" });
          return;
        }
        if (order.tenant_id !== config.testTenantId) {
          sendJson(res, 403, { error: "Order tenant mismatch" });
          return;
        }
        sendJson(res, 200, { order });
        return;
      }

      if (method === "GET" && path === "/v1/print-jobs") {
        if (!requireAuth(req, res, config)) return;
        const jobs = listPrintJobs({
          status: url.searchParams.get("status") || undefined,
          orderId: url.searchParams.get("orderId") || undefined,
        }).filter((j) => j.tenant_id === config.testTenantId);
        sendJson(res, 200, { jobs });
        return;
      }

      if (method === "POST" && path === "/v1/print-jobs/clear-history") {
        const auth = requireAuth(req, res, config, ["admin"]);
        if (!auth) return;
        try {
          const result = clearPrintJobHistory(config.testTenantId);
          recordAudit({
            actorRole: auth.role,
            actorUserId: auth.userId || "",
            action: "print.jobs.clear_history",
            entityType: "print_jobs",
            entityId: config.testTenantId,
            detail: { cleared: result.cleared },
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "GET" &&
        path.startsWith("/v1/print-jobs/") &&
        path.endsWith("/preview")
      ) {
        if (!requireAuth(req, res, config)) return;
        const jobId = decodeURIComponent(
          path.slice("/v1/print-jobs/".length, -"/preview".length)
        );
        const job = getPrintJob(jobId);
        if (!job || job.tenant_id !== config.testTenantId) {
          sendJson(res, 404, { error: "Job not found" });
          return;
        }
        const printer = getPrinter(job.printer_id);
        let payload = {};
        try {
          payload = JSON.parse(job.payload_snapshot);
        } catch {
          payload = {};
        }
        if (job.job_type === "CASHIER") payload = applyCashierCategories(payload);
        const text = renderTicketText(job.job_type, payload, {
          paperWidthMm: printer?.paper_width_mm || 80,
        });
        sendJson(res, 200, {
          jobId: job.job_id,
          jobType: job.job_type,
          stationId: job.station_id,
          printerId: job.printer_id,
          printerName: printer?.display_name || job.printer_id,
          status: job.status,
          text,
          payload,
        });
        return;
      }

      if (method === "GET" && path.startsWith("/v1/print-jobs/")) {
        if (!requireAuth(req, res, config)) return;
        const rest = path.slice("/v1/print-jobs/".length);
        const jobId = decodeURIComponent(rest.split("/")[0]);
        const job = getPrintJob(jobId);
        if (!job || job.tenant_id !== config.testTenantId) {
          sendJson(res, 404, { error: "Job not found" });
          return;
        }
        sendJson(res, 200, { job });
        return;
      }

      if (method === "POST" && path === "/v1/dispatch/run") {
        if (!requireAuth(req, res, config, ["admin"])) return;
        const results = await processAllPending(config);
        sendJson(res, 200, { processed: results });
        return;
      }

      if (
        method === "POST" &&
        path.startsWith("/v1/print-jobs/") &&
        path.endsWith("/confirm")
      ) {
        if (!requireAuth(req, res, config, ["admin"])) return;
        const jobId = decodeURIComponent(
          path.slice("/v1/print-jobs/".length, -"/confirm".length)
        );
        const body = await readBody(req).catch(() => ({}));
        try {
          const existing = getPrintJob(jobId);
          if (!existing || existing.tenant_id !== config.testTenantId) {
            sendJson(res, 404, { error: "Job not found" });
            return;
          }
          const job = confirmJob(jobId, body.note);
          sendJson(res, 200, { job });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (
        method === "POST" &&
        path.startsWith("/v1/print-jobs/") &&
        path.endsWith("/reprint")
      ) {
        if (!requireAuth(req, res, config, ["admin"])) return;
        const jobId = decodeURIComponent(
          path.slice("/v1/print-jobs/".length, -"/reprint".length)
        );
        try {
          const existing = getPrintJob(jobId);
          if (!existing || existing.tenant_id !== config.testTenantId) {
            sendJson(res, 404, { error: "Job not found" });
            return;
          }
          const job = requestReprint(jobId);
          sendJson(res, 201, { job });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      // P2-B2.1: A Kitchen session may load only the Preparation document.
      // The client-side navigation is advisory; enforce the page boundary here
      // as well, including direct URL entry, refresh and other browser tabs.
      if ((method === "GET" || method === "HEAD") &&
          (path === "/" || path.endsWith(".html"))) {
        const viewer = authenticateRequest(req, config);
        const restrictedPage = viewer.ok && (viewer.role === 'kitchen' || viewer.role === 'delivery');
        const landing = viewer.role === 'delivery' ? '/delivery-pool.html' : '/prep.html';
        if (restrictedPage && path !== landing) {
          res.writeHead(302, {
            Location: landing,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end();
          return;
        }
      }

      if (tryServeStatic(req, res, path)) return;

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) {
        log.error("HTTP handler error", { error: err.message, stack: err.stack });
      }
      sendJson(res, status, {
        error: err.message || "Server error",
      });
    }
  };

  if (config.tls) {
    return https.createServer(
      {
        cert: config.tls.cert,
        key: config.tls.key,
        passphrase: config.tls.passphrase,
        minVersion: "TLSv1.2",
      },
      handler
    );
  }
  return http.createServer(handler);
}
