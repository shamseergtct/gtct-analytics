/**
 * Central help copy for each app module.
 * Keep instructional text here instead of inline UI helper lines.
 */

export const HELP_MODULES = [
  {
    id: "sales",
    title: "Sales / Billing",
    path: "/sales",
    summary: "Barcode-first POS for retail, café, and wholesale layouts.",
    sections: [
      {
        title: "Retail POS basics",
        items: [
          "Scan a barcode or search by product code / name, then press Enter to add.",
          "Use ↑ / ↓ in search results and Enter to select a highlighted product.",
          "Rescanning a product increases quantity on an undescribed line.",
          "If a line has a description, rescanning the same product adds a new line.",
          "Each cart line supports description, quantity, and price edits.",
          "Qty − below 1 removes the line.",
        ],
      },
      {
        title: "Keyboard shortcuts",
        items: [
          "F2 — Focus search / barcode field",
          "F4 — Open customer panel",
          "F8 — Clear cart (when not typing in a field)",
          "F10 — Focus payment method",
          "F12 — Bill & Print",
        ],
      },
      {
        title: "Customer",
        items: [
          "Search customers by name, mobile number, or simple ID (C001, C002, …).",
          "Selecting a customer hides the list and shows editable details.",
          "Use Change to search again, or Walk-in for cash customers.",
          "New customers get an auto ID like C001 when billed.",
          "Credit payment opens the customer panel automatically.",
          "Walk-in is only for cash/bank sales with no named customer.",
        ],
      },
      {
        title: "Billing & print",
        items: [
          "Credit and Split / Partial are available at checkout.",
          "Full payment: choose Cash, a bank account, or Credit.",
          "Split / Partial: enter Cash, Bank, and/or Credit amounts that add up to the total.",
          "Any credit amount requires a customer (select from the list or enter details).",
          "Bill & Print saves the invoice, posts stock/accounting, then opens print.",
          "Finish Order saves without printing.",
          "Printer mode (A4 / Thermal) is under Order settings.",
          "If the browser blocks print, allow popups for this site.",
        ],
      },
    ],
  },
  {
    id: "inventory",
    title: "Inventory",
    path: "/inventory",
    summary: "Item entry, stock updates, and item audit for the active shop.",
    sections: [
      {
        title: "Item Entry",
        items: [
          "Create catalog items with code, name, cost, and selling price.",
          "Retail fields include barcode, reorder level, batch, and expiry.",
          "Use Export CSV / Import CSV for bulk catalog work.",
          "Edit from the Inventory Items list at the bottom of each tab.",
        ],
      },
      {
        title: "Stock Update",
        items: [
          "Click or Select an item in the catalog list to add it to the update table.",
          "Adjust current stock, new stock, damaged qty, cost, and selling price.",
          "Save Stock Update posts movements and updates on-hand quantities.",
        ],
      },
      {
        title: "Item Audit",
        items: [
          "Click or Select an item to open its movement ledger.",
          "Filter by movement type and date range as needed.",
        ],
      },
    ],
  },
  {
    id: "z-report",
    title: "Z-Report",
    path: "/shift-close",
    summary: "Enter and edit shift Z-reports for cash reconciliation.",
    sections: [
      {
        title: "Sales module totals",
        items: [
          "Cash sales, bank sales, and gross totals are fetched from POS invoices.",
          "The invoice list under Sales module totals shows each billed sale.",
          "Use on Cash sales to copy the POS cash total into Cash Total.",
          "Bank total still comes from the bank breakdown rows (account required).",
        ],
      },
      {
        title: "Closing cash",
        items: [
          "Enter Closing Cash Counted from the physical drawer count.",
          "Expected cash can be reviewed from the help icon near Closing Cash Counted.",
          "Gross Sales should equal Net Sales plus Credit Sales Total.",
        ],
      },
    ],
  },
  {
    id: "purchases",
    title: "Purchases & Expenses",
    path: "/purchases",
    summary: "Record purchases and operating expenses against the open shift.",
    sections: [
      {
        title: "Entry tips",
        items: [
          "Business date follows the active shift unless unlocked for edits.",
          "Choose the correct entry type (purchase vs expense) and category.",
          "Cash tender modes require an open shift.",
        ],
      },
    ],
  },
  {
    id: "payments-receipts",
    title: "Payments & Receipts",
    path: "/payments-receipts",
    summary: "Record money in/out with parties and payment modes.",
    sections: [
      {
        title: "Entry tips",
        items: [
          "Use receipt for money received and payment for money paid out.",
          "Business date follows the active shift when locked.",
          "Select bank account when using bank payment modes.",
        ],
      },
    ],
  },
  {
    id: "internal-transfers",
    title: "Internal Transfers",
    path: "/internal-transfers",
    summary: "Move value between cash, bank, petti, and locker.",
    sections: [
      {
        title: "Entry tips",
        items: [
          "Pick the correct transfer type (for example Cash to Locker).",
          "Transfers are internal and do not count as sales or expenses.",
          "Business date follows the active shift when locked.",
        ],
      },
    ],
  },
  {
    id: "parties",
    title: "Parties",
    path: "/parties",
    summary: "Customers, suppliers, and other party master data.",
    sections: [
      {
        title: "Customer IDs",
        items: [
          "Customers can have a simple ID such as C001.",
          "IDs are auto-generated for new customers from Sales or Parties.",
          "Search parties by name, contact, or ID.",
        ],
      },
      {
        title: "Bulk tools",
        items: [
          "Export CSV downloads the active shop party list.",
          "Import CSV creates parties for the active shop only.",
        ],
      },
    ],
  },
  {
    id: "bank-accounts",
    title: "Bank Accounts",
    path: "/bank-accounts",
    summary: "Manage shop bank accounts used for bank tender modes.",
    sections: [
      {
        title: "Basics",
        items: [
          "Add account name, bank name, and account number.",
          "Inactive accounts are hidden from payment selectors.",
        ],
      },
    ],
  },
  {
    id: "transactions",
    title: "Transactions",
    path: "/transactions",
    summary: "Browse posted accounting transactions for the active shop.",
    sections: [
      {
        title: "Basics",
        items: [
          "Filter and review posted sales, purchases, receipts, and transfers.",
          "Sales invoices from POS create related transaction documents.",
        ],
      },
    ],
  },
  {
    id: "end-of-day",
    title: "End of Day",
    path: "/reports/end-of-day",
    summary: "Close the business day and review Daily Pulse totals.",
    sections: [
      {
        title: "Date & sales",
        items: [
          "When a shift is open and no date is in the URL, End of Day uses the shift business date.",
          "Daily Sales prefers Sales-module (POS) totals; Z-report fills gaps only when needed.",
          "Refresh recalculates the live preview from transactions and Z-reports.",
        ],
      },
      {
        title: "Closing",
        items: [
          "Close Day locks the daily report after validation.",
          "Re-opened days can be closed again after edits.",
        ],
      },
    ],
  },
  {
    id: "reports",
    title: "Reports",
    path: "/reports-hub",
    summary: "Reports Hub, Daily Pulse, range reports, and party reports.",
    sections: [
      {
        title: "Where to look",
        items: [
          "Reports Hub — quick KPIs and detailed ledgers (including Sales Report).",
          "Daily Pulse — day-level performance snapshot.",
          "Range Reports — multi-day transaction reports.",
          "Party Reports — party-centric statements.",
        ],
      },
      {
        title: "Sales Report",
        items: [
          "Open Detailed Ledgers → Sales Report.",
          "Lists POS sales by invoice with customer and payment tender (Cash / Bank / Credit).",
          "Split payments appear as separate tender lines for the same invoice.",
          "Use Invoice / Party / Daily / Weekly / Monthly view types to roll up totals.",
          "Filter by party and payment (Cash / Bank / Credit) when multiple values exist.",
          "Days with no POS sales may show Z-report net sales as a fallback.",
        ],
      },
    ],
  },
  {
    id: "shifts",
    title: "Shifts",
    path: "/dashboard",
    summary: "Open and close shifts from the global status bar.",
    sections: [
      {
        title: "Open / close",
        items: [
          "Open New Shift with a business date before POS billing.",
          "Opening float is calculated automatically and not shown in the open dialog.",
          "Close Shift after Z-reports for the shift are entered.",
        ],
      },
    ],
  },
];

export function getHelpModule(moduleId) {
  const id = String(moduleId || "").trim().toLowerCase();
  return HELP_MODULES.find((module) => module.id === id) || null;
}

/** Map a route path to a help module id. */
export function helpModuleIdFromPath(pathname) {
  const path = String(pathname || "");
  if (path.startsWith("/sales")) return "sales";
  if (path.startsWith("/inventory")) return "inventory";
  if (path.startsWith("/shift-close")) return "z-report";
  if (path.startsWith("/purchases")) return "purchases";
  if (path.startsWith("/payments-receipts")) return "payments-receipts";
  if (path.startsWith("/internal-transfers")) return "internal-transfers";
  if (path.startsWith("/parties")) return "parties";
  if (path.startsWith("/bank-accounts")) return "bank-accounts";
  if (path.startsWith("/transactions")) return "transactions";
  if (path.startsWith("/reports/end-of-day")) return "end-of-day";
  if (
    path.startsWith("/reports") ||
    path.startsWith("/reports-hub") ||
    path.startsWith("/party-reports")
  ) {
    return "reports";
  }
  return "";
}
