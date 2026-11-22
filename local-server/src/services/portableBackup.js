/**
 * Admin portable TEST backup: download a verified SQLite snapshot, or replace
 * the live TEST database from an uploaded snapshot (with safety copy).
 * Menu image files on disk are out of scope (filenames only live in SQLite).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { closeDatabase, getDb, openDatabase, runMigrations } from "../db/db.js";
import { assertTestDatabaseIdentity } from "../operatingMode.js";

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

export function portableBackupConfirmPhrase(shopId) {
  return `IMPORT ${String(shopId || "").trim()}`;
}

function sha256File(file) {
  const sha = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      sha.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return sha.digest("hex");
}

function verifyPortableSqliteFile(filePath, config) {
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    fail(400, "Backup file is missing or not a regular file.", "BACKUP_MISSING");
  }
  const size = fs.statSync(filePath).size;
  if (!Number.isSafeInteger(size) || size <= 0) {
    fail(400, "Backup file is empty.", "BACKUP_EMPTY");
  }
  if (size > 250_000_000) {
    fail(413, "Backup file is too large (250 MB max).", "BACKUP_TOO_LARGE");
  }
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      fail(400, "Backup failed SQLite integrity check.", "BACKUP_CORRUPT");
    }
    if (db.pragma("foreign_key_check").length) {
      fail(400, "Backup failed foreign key check.", "BACKUP_FK");
    }
    const identity = assertTestDatabaseIdentity(db, config);
    if (!identity.identified) {
      fail(
        400,
        "Backup is not an identified TEST database for this shop.",
        "BACKUP_IDENTITY"
      );
    }
  } finally {
    db.close();
  }
  return { bytes: size, sha256: sha256File(filePath) };
}

function removeSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Hot-copy the live DB into a temp file and return bytes for download.
 */
export async function exportPortableBackup(config) {
  if (config.operatingMode !== "TEST") {
    fail(403, "Portable backup is only available in TEST mode.", "TEST_ONLY");
  }
  const live = getDb();
  try {
    live.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* best effort */
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `gtct-portable-${stamp}-${randomUUID().slice(0, 8)}.sqlite`;
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-portable-"));
  const scratch = path.join(scratchDir, filename);
  try {
    await live.backup(scratch);
    const meta = verifyPortableSqliteFile(scratch, config);
    const buffer = fs.readFileSync(scratch);
    return {
      filename,
      mimeType: "application/octet-stream",
      bytes: meta.bytes,
      sha256: meta.sha256,
      base64Data: buffer.toString("base64"),
      createdAt: new Date().toISOString(),
    };
  } finally {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Replace the live TEST database with an uploaded verified snapshot.
 * Keeps a local pre-import safety copy beside the live DB.
 */
export async function importPortableBackup(config, { base64Data, confirmPhrase }) {
  if (config.operatingMode !== "TEST") {
    fail(403, "Portable import is only available in TEST mode.", "TEST_ONLY");
  }
  const expected = portableBackupConfirmPhrase(config.testTenantId);
  if (String(confirmPhrase || "").trim() !== expected) {
    fail(400, `Type exactly: ${expected}`, "CONFIRM_PHRASE");
  }
  const raw = String(base64Data || "").replace(/\s+/g, "");
  if (!raw) fail(400, "Backup file data is required.", "BACKUP_REQUIRED");
  let buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    fail(400, "Backup data is not valid base64.", "BACKUP_BASE64");
  }
  if (!buffer.length) fail(400, "Backup file is empty.", "BACKUP_EMPTY");
  if (buffer.length > 250_000_000) {
    fail(413, "Backup file is too large (250 MB max).", "BACKUP_TOO_LARGE");
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-import-"));
  const scratch = path.join(scratchDir, `upload-${randomUUID()}.sqlite`);
  let safetyPath = "";
  let replacedLive = false;
  try {
    fs.writeFileSync(scratch, buffer, { flag: "wx", mode: 0o600 });
    const meta = verifyPortableSqliteFile(scratch, config);

    const dbPath = config.dbPath;
    const dataDir = path.dirname(dbPath);
    fs.mkdirSync(dataDir, { recursive: true });

    const live = getDb();
    try {
      live.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort */
    }
    closeDatabase();

    const safetyName = `gtct-local.pre-import-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.sqlite`;
    safetyPath = path.join(dataDir, safetyName);
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, safetyPath);
      try {
        fs.chmodSync(safetyPath, 0o600);
      } catch {
        /* Windows ACL */
      }
    }

    fs.copyFileSync(scratch, dbPath);
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* Windows ACL */
    }
    removeSidecars(dbPath);
    replacedLive = true;

    const db = openDatabase(dbPath);
    await runMigrations(db);
    assertTestDatabaseIdentity(db, config);

    return {
      bytes: meta.bytes,
      sha256: meta.sha256,
      safetyCopyKept: Boolean(safetyPath && fs.existsSync(safetyPath)),
      requiresReload: true,
    };
  } catch (err) {
    if (replacedLive) {
      try {
        try {
          closeDatabase();
        } catch {
          /* ignore */
        }
        if (safetyPath && fs.existsSync(safetyPath)) {
          fs.copyFileSync(safetyPath, config.dbPath);
          removeSidecars(config.dbPath);
        }
        openDatabase(config.dbPath);
      } catch {
        /* operator may need to restore manually from *.pre-import-*.sqlite */
      }
    }
    throw err;
  } finally {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
