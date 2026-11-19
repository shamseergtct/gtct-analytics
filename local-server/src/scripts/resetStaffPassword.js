/**
 * Reset a staff password on the computer that holds the shop database.
 *
 * Interactive (recommended on the restaurant PC):
 *   npm run admin:reset-password
 *
 * Non-interactive:
 *   npm run admin:reset-password -- --list
 *   npm run admin:reset-password -- --username admin --password 'NewPass12' --confirm 'NewPass12'
 *
 * Windows installed pilot sets GTCT_LOCAL_DATA_DIR to
 *   %LOCALAPPDATA%\GTCT\RestaurantPilot
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { inspectExistingTestDatabase, stampMigratedTestDatabase } from "../db/testStartup.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { clearLoginThrottle } from "../services/staffAuth.js";
import {
  findStaffUserIdByUsername,
  listStaffAccounts,
  resetStaffPassword,
} from "../services/staffUsers.js";

function parseArgs(argv) {
  const out = { list: false, username: "", password: "", confirm: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") out.list = true;
    else if (arg === "--username") out.username = String(argv[++i] || "");
    else if (arg === "--password") out.password = String(argv[++i] || "");
    else if (arg === "--confirm") out.confirm = String(argv[++i] || "");
  }
  return out;
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
      reject(new Error("This terminal cannot hide password input. Use --password and --confirm flags."));
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

function printAccounts(accounts) {
  if (!accounts.length) {
    console.log("No staff accounts found in this database.");
    return;
  }
  console.log("Staff accounts:");
  for (const row of accounts) {
    const status = row.isActive ? "active" : "inactive";
    console.log(`  - ${row.username} (${row.role}, ${status}) — ${row.fullName}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ mode: "script" });
  inspectExistingTestDatabase(config);
  ensureDataDirs(config);

  if (!fs.existsSync(config.dbPath)) {
    console.error(`No database found at ${config.dbPath}`);
    console.error("Start the restaurant app once, or create the first admin with: npm run admin:create");
    process.exitCode = 1;
    return;
  }

  openDatabase(config.dbPath);
  try {
    await runMigrations(getDb());
    stampMigratedTestDatabase(getDb(), config);
    const shopId = config.testTenantId;
    const accounts = listStaffAccounts(shopId);

    if (args.list) {
      printAccounts(accounts);
      return;
    }

    printAccounts(accounts);
    if (!accounts.length) {
      console.error("Create the first administrator with: npm run admin:create");
      process.exitCode = 1;
      return;
    }

    let username = String(args.username || "").trim();
    let password = args.password;
    let confirm = args.confirm;

    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!username) {
      if (!interactive) {
        console.error("Provide --username, or run interactively in a terminal.");
        process.exitCode = 1;
        return;
      }
      username = (await askVisible("Username to reset: ")).trim();
    }

    const found = findStaffUserIdByUsername(shopId, username);
    if (!found) {
      console.error(`No staff account matches username "${username}".`);
      process.exitCode = 1;
      return;
    }
    if (!found.isActive) {
      console.error(`Account "${found.username}" is inactive. Ask an Admin to reactivate it in Users.`);
      process.exitCode = 1;
      return;
    }

    if (!password || !confirm) {
      if (!interactive) {
        console.error("Provide --password and --confirm, or run interactively in a terminal.");
        process.exitCode = 1;
        return;
      }
      password = await askHidden("New password: ");
      confirm = await askHidden("Confirm new password: ");
    }

    try {
      const result = resetStaffPassword(
        shopId,
        found.userId,
        { password, confirmPassword: confirm },
        { role: "ops_cli", userId: "cli:reset-password" }
      );
      clearLoginThrottle();
      password = "";
      confirm = "";
      console.log(`Password reset for ${result.username}. Sign in on the restaurant page.`);
      console.log("All existing sessions for this user were signed out.");
    } catch (err) {
      password = "";
      confirm = "";
      console.error(err instanceof Error ? err.message : "Password reset failed.");
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
