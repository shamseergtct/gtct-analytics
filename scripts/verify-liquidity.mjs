/**
 * One-off verification: liquidity for client "test"
 * Run: node scripts/verify-liquidity.mjs
 */
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  doc,
  getDoc,
  Timestamp,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBrNIsJihV5XxsCx6VSUg2_SPpgqLK4QjE",
  authDomain: "gtct-global-analytics.firebaseapp.com",
  projectId: "gtct-global-analytics",
  storageBucket: "gtct-global-analytics.firebasestorage.app",
  messagingSenderId: "311665553348",
  appId: "1:311665553348:web:ffcd2bcf8ae36bf0477e91",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function endOfDay(yyyyMMdd) {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

async function findClientByName(name) {
  const snap = await getDocs(collection(db, "clients"));
  for (const d of snap.docs) {
    const data = d.data();
    if (String(data?.name || "").toLowerCase() === name.toLowerCase()) {
      return { id: d.id, ...data };
    }
  }
  return null;
}

async function fetchTxnsTill(clientId, toDate) {
  const veryOld = Timestamp.fromDate(new Date(1970, 0, 1));
  const to = Timestamp.fromDate(endOfDay(toDate));
  const qy = query(
    collection(db, "transactions"),
    where("clientId", "==", clientId),
    where("date", ">=", veryOld),
    where("date", "<=", to),
    orderBy("date", "desc")
  );
  const snap = await getDocs(qy);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getOpening(clientId, fromDate) {
  const prev = new Date(fromDate);
  prev.setDate(prev.getDate() - 1);
  const prevKey = toYYYYMMDD(prev);

  const settingsSnap = await getDoc(doc(db, "client_settings", clientId));
  const closings = settingsSnap.exists() ? settingsSnap.data()?.dailyClosings || {} : {};
  const prevClosing = closings[prevKey];

  if (prevClosing?.actualCashDrawer != null) {
    return {
      cash: num(prevClosing.actualCashDrawer),
      bank: num(prevClosing.closingBankBalance),
      source: `saved closing ${prevKey}`,
    };
  }

  const d = settingsSnap.exists() ? settingsSnap.data() : {};
  return {
    cash: num(d.openingCashFrom ?? d.openingCash),
    bank: num(d.openingBankFrom ?? d.openingBank),
    source: "client_settings defaults",
  };
}

// Inline minimal liquidity calc (same as reportCalculations)
function normalizeMode(m) {
  const x = String(m || "").trim().toLowerCase();
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban") || x.startsWith("car") || x.startsWith("upi")) return "bank";
  if (x.startsWith("cre")) return "credit";
  if (x.startsWith("petti") || x.startsWith("petty") || x.includes("petti cash")) return "petti";
  return x;
}
function normalizeType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  if (x.startsWith("tra")) return "transfer";
  return x;
}
function inValue(t) {
  return num(t?.amountIn) || num(t?.amount);
}
function outValue(t) {
  const out = num(t?.amountOut);
  if (out > 0) return out;
  const ty = normalizeType(t?.type);
  if (ty === "purchase" || ty === "payment" || ty === "expense") return num(t?.amountIn);
  return 0;
}
function isInternalTransfer(t) {
  if (t?.internalTransfer === true) return true;
  const ty = normalizeType(t?.type);
  const m = normalizeMode(t?.mode);
  const src = String(t?.sourceMode || "").trim();
  if ((ty === "transfer" || ty === "refill") && m === "petti" && src) return true;
  return false;
}

function calcLiquidity(txnsTill, openingCash, openingBank) {
  const normal = txnsTill.filter((t) => !isInternalTransfer(t));
  const sum = (arr, fn) => arr.reduce((s, x) => s + num(fn(x)), 0);

  const cashIn = sum(normal.filter((t) => normalizeMode(t?.mode) === "cash"), inValue);
  const cashOut = sum(normal.filter((t) => normalizeMode(t?.mode) === "cash"), outValue);
  const bankIn = sum(normal.filter((t) => normalizeMode(t?.mode) === "bank"), inValue);
  const bankOut = sum(normal.filter((t) => normalizeMode(t?.mode) === "bank"), outValue);
  const pettiIn = sum(normal.filter((t) => normalizeMode(t?.mode) === "petti"), inValue);
  const pettiOut = sum(normal.filter((t) => normalizeMode(t?.mode) === "petti"), outValue);

  let cash = num(openingCash) + (cashIn - cashOut);
  let bank = num(openingBank) + (bankIn - bankOut);
  let petti = pettiIn - pettiOut;

  for (const t of txnsTill.filter(isInternalTransfer)) {
    const amt = num(t?.totalAmount) || num(t?.amountIn) || num(t?.amountOut);
    if (amt <= 0) continue;
    const src = normalizeMode(t?.sourceMode);
    if (src === "cash") cash -= amt;
    else if (src === "bank") bank -= amt;
    petti += amt;
  }

  return { cash, bank, petti, total: cash + bank + petti, cashIn, cashOut, bankIn, bankOut };
}

async function main() {
  const client = await findClientByName("test");
  if (!client) {
    console.log("Client 'test' not found");
    process.exit(1);
  }
  console.log("Client:", client.name, "id:", client.id);

  // Use latest transaction date or June 2026 from screenshots
  const toDate = "2026-06-17";
  const fromDate = "2026-06-17";

  const opening = await getOpening(client.id, fromDate);
  console.log("\nOpening:", opening);

  const txns = await fetchTxnsTill(client.id, toDate);
  console.log("Transactions till", toDate + ":", txns.length);

  const liq = calcLiquidity(txns, opening.cash, opening.bank);
  console.log("\n=== CALCULATED LIQUIDITY ===");
  console.log("Cash:", liq.cash.toFixed(2));
  console.log("Bank:", liq.bank.toFixed(2));
  console.log("Petti:", liq.petti.toFixed(2));
  console.log("Total:", liq.total.toFixed(2));
  console.log("\nBreakdown:");
  console.log("  Opening cash:", opening.cash);
  console.log("  Cash in/out:", liq.cashIn, "/", liq.cashOut, "=> net", liq.cashIn - liq.cashOut);
  console.log("  Opening bank:", opening.bank);
  console.log("  Bank in/out:", liq.bankIn, "/", liq.bankOut, "=> net", liq.bankIn - liq.bankOut);

  console.log("\n=== SCREENSHOT VALUES ===");
  console.log("Cash: 2780.00, Bank: 71831.00, Petti: 0.00, Total: 74611.00");
  console.log("\nMatch?", {
    cash: Math.abs(liq.cash - 2780) < 0.01,
    bank: Math.abs(liq.bank - 71831) < 0.01,
    total: Math.abs(liq.total - 74611) < 0.01,
  });

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
