// src/utils/accountingV2/reports.js
import { buildLedger } from "./ledger.js";

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list || []) {
    const k = String(keyFn(x) ?? "").trim() || "—";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function sum(list, pick) {
  let s = 0;
  for (const x of list || []) s += Number(pick(x) || 0);
  return s;
}

/**
 * Phase-2 reports (Preview mode)
 * SAFE: Uses ledger built from existing txns + virtual postings.
 * No UI assumptions.
 */
export function generateAdvancedReports({
  rawTransactions,
  rangeStart,
  rangeEnd,
  includeVirtualDiscount = true,
  includeVirtualDepreciation = true,
}) {
  const { ledger, registers, totals } = buildLedger({
    rawTransactions,
    rangeStart,
    rangeEnd,
    includeVirtualDiscount,
    includeVirtualDepreciation,
  });

  // Employee / Partner (only if those partyTypes exist in data)
  const employeeTx = ledger.filter((x) => x.partyType === "employee");
  const employeeGroups = groupBy(employeeTx, (x) => x.partyName || x.id);
  const employeeReport = Array.from(employeeGroups.entries()).map(([k, rows]) => ({
    employee: k,
    salary: sum(rows.filter((r) => r.category === "salary"), (r) => r.amount),
    advances: sum(rows.filter((r) => r.category === "advance"), (r) => r.amount),
    reimbursement: sum(rows.filter((r) => r.category === "reimbursement"), (r) => r.amount),
    loan: sum(rows.filter((r) => r.category === "loan"), (r) => r.amount),
    payable: sum(rows.filter((r) => r.txType === "expense"), (r) => r.amount),
    count: rows.length,
  }));

  const partnerTx = ledger.filter((x) => x.partyType === "owner_partner");
  const partnerGroups = groupBy(partnerTx, (x) => x.partyName || x.id);
  const partnerReport = Array.from(partnerGroups.entries()).map(([k, rows]) => ({
    partner: k,
    capital: sum(rows.filter((r) => r.category === "capital"), (r) => r.amount),
    drawings: sum(rows.filter((r) => r.category === "drawings"), (r) => r.amount),
    loan: sum(rows.filter((r) => r.category === "loan"), (r) => r.amount),
    income: sum(rows.filter((r) => r.txType === "income"), (r) => r.amount),
    expense: sum(rows.filter((r) => r.txType === "expense"), (r) => r.amount),
    net: sum(rows.filter((r) => r.txType === "income"), (r) => r.amount) - sum(rows.filter((r) => r.txType === "expense"), (r) => r.amount),
    count: rows.length,
  }));

  // Discount impact
  const discountAllowed = sum(ledger.filter((x) => x.category === "discount_allowed"), (x) => x.amount);
  const discountReceived = sum(ledger.filter((x) => x.category === "discount_received"), (x) => x.amount);

  // Asset + Depreciation
  const assets = registers.assets || [];
  const depreciationTotal = sum(ledger.filter((x) => x.category === "depreciation" && x.mode === "system"), (x) => x.amount);

  return {
    totals,
    discount: { allowed: discountAllowed, received: discountReceived },
    assets: {
      registerCount: assets.length,
      register: assets,
      depreciationTotal,
    },
    employeeReport,
    partnerReport,
  };
}
