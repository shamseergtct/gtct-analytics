import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WELL_KNOWN_DEV_TOKEN = "phase1-dev-token";
const WELL_KNOWN_ADMIN_TOKEN = "phase1-admin-token";

/**
 * Persistent data directory.
 * - Windows: %LOCALAPPDATA%\GTCT\RestaurantLocalServer
 * - Other (dev): local-server/data
 */
export function resolveDataDir() {
  const override = String(process.env.GTCT_LOCAL_DATA_DIR || "").trim();
  if (override) return path.resolve(override);

  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "GTCT", "RestaurantLocalServer");
  }

  return path.join(ROOT, "data");
}

export function isLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (
    h === "::1" ||
    h === "[::1]" ||
    h === "localhost" ||
    h === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isWildcardBind(host) {
  const h = String(host || "").trim().toLowerCase();
  return h === "0.0.0.0" || h === "::" || h === "[::]" || h === "*";
}

function isSpecificLanIpv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split(".").map(Number);
  if (parts.some((part) => part > 255)) return false;
  if (isLoopbackHost(host) || isWildcardBind(host)) return false;
  return true;
}

export function isPrivateLanIpv4(host) {
  if (!isSpecificLanIpv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function approvedLanHostname(value) {
  const name = String(value || "").trim().toLowerCase();
  if (name === "localhost") return "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return "";
  return name;
}

function certificateDnsNames(cert) {
  let parsed;
  try {
    parsed = new X509Certificate(cert);
  } catch {
    return { names: [], ips: [], expired: true };
  }
  const names = [];
  const ips = [];
  for (const part of String(parsed.subjectAltName || "").split(",")) {
    const trimmed = part.trim();
    const dns = /^DNS:(.+)$/i.exec(trimmed);
    if (dns) names.push(dns[1].trim().toLowerCase());
    const ip = /^IP(?: Address)?:(.+)$/i.exec(trimmed);
    if (ip) ips.push(ip[1].trim());
  }
  const expires = new Date(parsed.validTo);
  return {
    names,
    ips,
    expired: Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now(),
  };
}

/**
 * Read TLS material only when HTTPS is requested.
 * Missing or invalid material fails closed. Nothing here is written to logs.
 */
function readTlsMaterial(errors) {
  const certPath = String(process.env.GTCT_TLS_CERT_FILE || "").trim();
  const keyPath = String(process.env.GTCT_TLS_KEY_FILE || "").trim();
  const passphrase = process.env.GTCT_TLS_KEY_PASSPHRASE;
  const requested = Boolean(certPath || keyPath || (passphrase != null && passphrase !== ""));
  if (!requested) return null;
  if (!certPath || !keyPath) {
    errors.push(
      "HTTPS requires both GTCT_TLS_CERT_FILE and GTCT_TLS_KEY_FILE. Startup will not fall back to HTTP."
    );
    return null;
  }
  let cert;
  let key;
  try {
    cert = fs.readFileSync(certPath);
    key = fs.readFileSync(keyPath);
  } catch {
    errors.push("HTTPS certificate or private key file could not be read.");
    return null;
  }
  if (!cert.length || !key.length) {
    errors.push("HTTPS certificate or private key file is empty.");
    return null;
  }
  try {
    tls.createSecureContext({
      cert,
      key,
      passphrase: passphrase || undefined,
      minVersion: "TLSv1.2",
    });
  } catch {
    errors.push(
      "HTTPS certificate and private key could not be loaded. Check the files and GTCT_TLS_KEY_PASSPHRASE."
    );
    return null;
  }
  return {
    cert,
    key,
    passphrase: passphrase || undefined,
    minVersion: "TLSv1.2",
  };
}

function pathWithin(candidate, parent) {
  const a = path.resolve(candidate);
  const b = path.resolve(parent);
  const relative = path.relative(b, a);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function reservedProductionDir() {
  const explicit = String(process.env.GTCT_PRODUCTION_DATA_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "GTCT", "RestaurantProductionServer");
  }
  return path.join(ROOT, "data-production");
}

function envFlag(name) {
  return String(process.env[name] || "").toLowerCase() === "true";
}

/**
 * Load and validate Phase 1 local-server config.
 *
 * Security rules:
 * - Default bind is 127.0.0.1 (loopback only).
 * - Loopback HTTP remains available when TLS files are not configured.
 * - Partial or invalid TLS configuration refuses to start. There is no HTTP fallback.
 * - Non-loopback bind requires two explicit flags, one private IPv4 address, and valid HTTPS.
 * - LAN stays off unless GTCT_ENABLE_LAN_LISTENER=true is also set. Default startup does not set it.
 * - The certificate must include the approved hostname. There is no HTTP fallback.
 * - Wildcard binds such as 0.0.0.0 are rejected. Public addresses are rejected.
 * - Well-known dev tokens never authorize a request or a LAN bind.
 * - Shared bearer secrets are retired and are not accepted by the API.
 */
/**
 * @param {{ mode?: 'http' | 'script', throwOnError?: boolean }} [options]
 * - http: full security validation (server start)
 * - script: local CLI tools (seed/demo/migrate) — no token/bind enforcement
 */
export function loadConfig(options = {}) {
  const mode = options.mode || "http";
  const dataDir = resolveDataDir();
  const requestedOperatingMode = String(process.env.GTCT_OPERATING_MODE || "TEST").trim().toUpperCase();
  const port = Number(process.env.GTCT_LOCAL_PORT || 8787);
  const host = String(process.env.GTCT_LOCAL_HOST || "127.0.0.1");
  const physicalPrintEnabled = envFlag("GTCT_ENABLE_PHYSICAL_PRINT");
  const allowTcpProbe = envFlag("GTCT_ALLOW_TCP_PROBE");
  const allowLanBind = envFlag("GTCT_ALLOW_LAN_BIND");
  const enableLanListener = envFlag("GTCT_ENABLE_LAN_LISTENER");
  const allowDevToken = envFlag("GTCT_ALLOW_DEV_TOKEN");
  const loopback = isLoopbackHost(host);
  const lanHostname = approvedLanHostname(process.env.GTCT_LAN_HOSTNAME);

  let apiToken = String(process.env.GTCT_LOCAL_API_TOKEN || "").trim();
  let adminToken = String(process.env.GTCT_LOCAL_ADMIN_TOKEN || "").trim();

  const warnings = [];
  const errors = [];
  const tlsMaterial = readTlsMaterial(errors);

  // Production execution is deliberately unavailable in Phase P2-A1, including
  // CLI seed/migrate paths. Never treat a UI flag as production authorization.
  if (requestedOperatingMode !== "TEST") {
    errors.push("Only TEST operating mode is implemented. Real restaurant startup is blocked.");
  }

  // Prevent TEST scripts and servers from targeting the reserved REAL data dir.
  // Compare resolved paths; reject symlink aliases to an existing reserved dir.
  const productionDir = reservedProductionDir();
  const canonical = (p) => {
    // Resolve symlinked existing ancestors even when the final data folder
    // has not been created yet (a common first-start scenario).
    let current = path.resolve(p);
    const missing = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
    }
    try { return path.join(fs.realpathSync(current), ...missing); }
    catch { return path.resolve(p); }
  };
  if (pathWithin(canonical(dataDir), canonical(productionDir)) ||
      pathWithin(dataDir, productionDir)) {
    errors.push("TEST cannot use the reserved production data directory.");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`Invalid GTCT_LOCAL_PORT: ${port}`);
  }

  if (mode === "http" && enableLanListener && loopback) {
    errors.push(
      "GTCT_ENABLE_LAN_LISTENER cannot use the loopback address. LAN stays off."
    );
  }

  if (mode === "http" && !loopback) {
    if (isWildcardBind(host)) {
      errors.push(
        "Binding to 0.0.0.0 or :: is not allowed. Choose one approved IPv4 address."
      );
    }
    if (!allowLanBind) {
      errors.push(
        `Host ${host} is not loopback. LAN access requires GTCT_ALLOW_LAN_BIND=true, valid HTTPS, and one approved address.`
      );
    }
    const approvedAddress = String(process.env.GTCT_LAN_BIND_ADDRESS || "").trim();
    if (!isPrivateLanIpv4(host)) {
      errors.push(
        "LAN bind requires one private IPv4 address on this computer. Public and wildcard addresses are refused."
      );
    } else if (approvedAddress !== host) {
      errors.push(
        "LAN bind requires GTCT_LOCAL_HOST and GTCT_LAN_BIND_ADDRESS to be the same specific IPv4 address."
      );
    }
    if (!tlsMaterial) {
      errors.push(
        "LAN access requires a valid HTTPS certificate and private key. HTTP is not used outside this computer."
      );
    }
    if (apiToken || adminToken) {
      if (apiToken && adminToken && apiToken === adminToken) {
        errors.push("GTCT_LOCAL_API_TOKEN and GTCT_LOCAL_ADMIN_TOKEN must differ.");
      }
      if (
        apiToken === WELL_KNOWN_DEV_TOKEN ||
        adminToken === WELL_KNOWN_ADMIN_TOKEN
      ) {
        errors.push(
          "Well-known development tokens cannot be used when binding outside loopback."
        );
      }
      if ((apiToken && apiToken.length < 24) || (adminToken && adminToken.length < 24)) {
        errors.push("Shared bearer tokens do not authorize LAN access.");
      }
    }
    if (!enableLanListener) {
      errors.push(
        "LAN listening is not enabled. The server stays on this computer until GTCT_ENABLE_LAN_LISTENER=true is set for an approved private test."
      );
    } else {
      const rawDataDir = String(process.env.GTCT_LOCAL_DATA_DIR || "");
      if (rawDataDir.startsWith("\\\\") || rawDataDir.startsWith("//")) {
        errors.push(
          "The database must stay on this computer. A network folder is not allowed."
        );
      }
      // Physical print may stay on for Mac/LAN terminal testing when explicitly enabled.
      if (!lanHostname) {
        errors.push(
          "LAN access requires GTCT_LAN_HOSTNAME to be one private name such as gtct-pos."
        );
      } else if (tlsMaterial) {
        const san = certificateDnsNames(tlsMaterial.cert);
        if (san.expired || !san.names.includes(lanHostname)) {
          errors.push(
            `The HTTPS certificate must name DNS:${lanHostname} and must not be expired.`
          );
        }
        // Phones cannot edit hosts files; cert must also cover this Mac's LAN IP.
        if (isPrivateLanIpv4(host) && !san.ips.includes(host)) {
          errors.push(
            `The HTTPS certificate must also include IP:${host} so phones can open https://${host} without DNS.`
          );
        }
      }
    }
  }

  const lanAccessReady =
    mode === "http" &&
    enableLanListener &&
    !loopback &&
    errors.length === 0 &&
    Boolean(tlsMaterial) &&
    Boolean(lanHostname);

  if (physicalPrintEnabled) {
    warnings.push(
      "Physical printing enabled. MOCK remains the supported Phase 1 default path."
    );
  }
  if (allowTcpProbe) {
    warnings.push(
      "TCP probe enabled (connect-only, no print payload). Use only on trusted lab networks."
    );
  }

  const supportMasterKey = String(process.env.GTCT_SUPPORT_MASTER_KEY || "").trim();

  const config = {
    rootDir: ROOT,
    dataDir,
    dbPath: path.join(dataDir, "gtct-local.sqlite"),
    printOutputDir: path.join(dataDir, "print-output"),
    menuImagesDir: path.join(dataDir, "menu-images"),
    shopAssetsDir: path.join(dataDir, "shop-assets"),
    logDir: path.join(dataDir, "logs"),
    host,
    port,
    loopback,
    allowLanBind,
    enableLanListener,
    lanHostname: lanAccessReady ? lanHostname : "",
    allowDevToken,
    physicalPrintEnabled,
    allowTcpProbe,
    operatingMode: requestedOperatingMode,
    testTenantId: "test-tenant-phase1",
    restaurantDisplayName: "GTCT RESTAURANT — KITCHEN TEST",
    apiToken,
    adminToken,
    supportMasterKey,
    dispatchIntervalMs: Number(process.env.GTCT_DISPATCH_INTERVAL_MS || 1500),
    tls: tlsMaterial,
    lanAccessReady,
    tlsReady: Boolean(tlsMaterial),
    warnings,
    errors,
  };

  if (options.throwOnError !== false && errors.length) {
    const err = new Error(
      `Invalid local-server config:\n- ${errors.join("\n- ")}`
    );
    err.configErrors = errors;
    throw err;
  }

  return config;
}

export function ensureDataDirs(config) {
  for (const dir of [
    config.dataDir,
    config.printOutputDir,
    config.menuImagesDir,
    config.shopAssetsDir,
    config.logDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export { WELL_KNOWN_DEV_TOKEN, WELL_KNOWN_ADMIN_TOKEN };
