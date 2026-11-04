/**
 * Local-only first administrator setup.
 *
 * Run this in a terminal on the computer that runs the restaurant server:
 *   npm run admin:create
 *
 * There is no web page and no default password. Shared bearer secrets are
 * retired. If this shop already has an active Admin, sign in with that
 * username and password. Do not add a shared secret to recover access.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { loadConfig, ensureDataDirs } from "../config.js";
import { inspectExistingTestDatabase, stampMigratedTestDatabase } from "../db/testStartup.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { createFirstAdmin, StaffAuthError } from "../services/staffAuth.js";

export async function backupDatabase(sourcePath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destPath);
  } finally {
    source.close();
  }
}

function askVisible(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(String(answer || ""));
    });
  });
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (typeof stdin.setRawMode !== "function") {
      reject(new Error("This terminal cannot hide password input."));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("\u0003")) {
        cleanup();
        stdout.write("\n");
        reject(new Error("cancelled"));
        return;
      }
      if (text.includes("\r") || text.includes("\n")) {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (text.startsWith("\u001b")) return;
      value += text;
    };
    function cleanup() {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
    }
    stdin.on("data", onData);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run this command in a terminal on the computer that runs the restaurant server.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ mode: "script" });
  inspectExistingTestDatabase(config);
  ensureDataDirs(config);
  const existed = fs.existsSync(config.dbPath);
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(config.dataDir, "backups", `gtct-local-before-first-admin-${stamp}.sqlite`);
    try {
      await backupDatabase(config.dbPath, dest);
    } catch (err) {
      console.error("Database backup failed. No administrator account was created.");
      console.error(err instanceof Error ? err.message : "Backup failed");
      process.exitCode = 1;
      return;
    }
    console.log(`Database backup saved to ${dest}`);
  } else {
    console.log("No database file was found yet. Migrations will create one for this shop.");
  }

  openDatabase(config.dbPath);
  try {
    await runMigrations(getDb());
    stampMigratedTestDatabase(getDb(), config);
    const fullName = (await askVisible("Administrator name: ")).trim();
    const username = (await askVisible("Username: ")).trim();
    let password = await askHidden("Password: ");
    let confirm = await askHidden("Confirm password: ");
    if (password !== confirm) {
      password = "";
      confirm = "";
      console.error("The passwords did not match. Nothing was created.");
      process.exitCode = 1;
      return;
    }
    try {
      const created = createFirstAdmin({
        shopId: config.testTenantId,
        fullName,
        username,
        password,
      });
      password = "";
      confirm = "";
      console.log(`Administrator account created for ${created.username}.`);
      console.log("Sign in from the restaurant page on this computer. The password was not saved in a file.");
    } catch (err) {
      password = "";
      confirm = "";
      if (err instanceof StaffAuthError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      console.error("The administrator account could not be created.");
      process.exitCode = 1;
    }
  } finally {
    closeDatabase();
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  await main();
}
