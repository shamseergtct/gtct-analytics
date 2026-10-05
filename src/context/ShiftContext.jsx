import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteField,
  doc,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthContext";
import { useClient } from "./ClientContext";
import {
  buildTransactionPayload,
  toBusinessDate,
} from "../utils/transactionContract";
import { ShiftContext } from "./shift-context";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toCents(value) {
  return Math.round(num(value) * 100);
}

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const UNSAVED_WORK_KEY = "gtct_unsaved_work";

function readStoredUnsavedWork(clientId) {
  if (!clientId || typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(`${UNSAVED_WORK_KEY}:${clientId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredUnsavedWork(clientId, value) {
  if (!clientId || typeof window === "undefined") return;
  try {
    const key = `${UNSAVED_WORK_KEY}:${clientId}`;
    if (!value || !Object.keys(value).length) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // session persistence is optional
  }
}

export function ShiftProvider({ children }) {
  const { user } = useAuth();
  const { activeClientId } = useClient();
  const [activeShift, setActiveShift] = useState(null);
  const [loadedClientId, setLoadedClientId] = useState("");
  const [shiftErrorState, setShiftErrorState] = useState(null);
  const [unsavedWork, setUnsavedWorkState] = useState(() =>
    readStoredUnsavedWork(activeClientId)
  );

  useEffect(() => {
    setUnsavedWorkState(readStoredUnsavedWork(activeClientId));
  }, [activeClientId]);

  const setUnsavedWork = useCallback(
    (moduleId, labelOrNull) => {
      if (!moduleId) return;
      setUnsavedWorkState((current) => {
        const nextLabel =
          labelOrNull && String(labelOrNull).trim()
            ? String(labelOrNull).trim()
            : null;
        let next = current;
        if (!nextLabel) {
          if (!(moduleId in current)) return current;
          next = { ...current };
          delete next[moduleId];
        } else if (current[moduleId] === nextLabel) {
          return current;
        } else {
          next = { ...current, [moduleId]: nextLabel };
        }
        writeStoredUnsavedWork(activeClientId, next);
        return next;
      });
    },
    [activeClientId]
  );

  const unsavedWorkLabels = useMemo(
    () => Object.values(unsavedWork).filter(Boolean),
    [unsavedWork]
  );

  useEffect(() => {
    if (!activeClientId) return undefined;
    const shiftsQuery = query(
      collection(db, "shifts"),
      where("clientId", "==", activeClientId),
      where("status", "==", "OPEN"),
      limit(1)
    );
    let initialSnapshotPending = true;
    console.time("Shift Operation: Active Listener");
    return onSnapshot(
      shiftsQuery,
      (snap) => {
        if (initialSnapshotPending) {
          console.timeEnd("Shift Operation: Active Listener");
          initialSnapshotPending = false;
        }
        const item = snap.docs[0];
        setActiveShift(item ? { id: item.id, ...item.data() } : null);
        setLoadedClientId(activeClientId);
        setShiftErrorState(null);
      },
      (error) => {
        if (initialSnapshotPending) {
          console.timeEnd("Shift Operation: Active Listener");
          initialSnapshotPending = false;
        }
        console.error("Shift listener failed:", error);
        setShiftErrorState({
          clientId: activeClientId,
          message: error?.message || "Failed to load active shift.",
        });
        setLoadedClientId(activeClientId);
      }
    );
  }, [activeClientId]);

  const currentActiveShift =
    activeShift?.clientId === activeClientId ? activeShift : null;
  const loadingShift = Boolean(activeClientId) && loadedClientId !== activeClientId;
  const shiftError =
    shiftErrorState?.clientId === activeClientId
      ? shiftErrorState.message
      : "";

  async function openShift({ openingFloat, businessDate = todayYYYYMMDD() }) {
    if (!activeClientId) throw new Error("Select an active shop first.");
    if (!user?.uid) throw new Error("You must be signed in.");
    if (num(openingFloat) < 0) throw new Error("Opening float cannot be negative.");

    const shiftRef = doc(collection(db, "shifts"));
    const settingsRef = doc(db, "client_settings", activeClientId);
    const openedAtMs = Date.now();

    console.time("Shift Operation: Open");
    let transactionAttempts = 0;
    try {
      await runTransaction(db, async (tx) => {
        transactionAttempts += 1;
        const settingsSnap = await tx.get(settingsRef);
        const currentShiftId = settingsSnap.data()?.activeShiftId || "";
        let currentShiftSnap = null;
        if (currentShiftId) {
          currentShiftSnap = await tx.get(doc(db, "shifts", currentShiftId));
        }

        if (currentShiftSnap?.exists() && currentShiftSnap.data()?.status === "OPEN") {
          throw new Error("This shop already has an open shift.");
        }

        tx.set(shiftRef, {
          clientId: activeClientId,
          businessDate,
          businessDateAt: toBusinessDate(businessDate),
          openedBy: user.uid,
          openedAt: serverTimestamp(),
          openedAtMs,
          openingFloat: num(openingFloat),
          closedBy: null,
          closedAt: null,
          closedAtMs: null,
          closingCashCounted: null,
          zReportId: null,
          status: "OPEN",
        });
        tx.set(
          settingsRef,
          {
            clientId: activeClientId,
            activeShiftId: shiftRef.id,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      });

      return shiftRef.id;
    } finally {
      console.debug("Shift Operation: Open transaction attempts", transactionAttempts);
      console.timeEnd("Shift Operation: Open");
    }
  }

  async function saveZReport({ closingCashCounted, zReport }) {
    if (!activeClientId) throw new Error("Select an active shop first.");
    if (!user?.uid) throw new Error("You must be signed in.");
    if (!currentActiveShift?.id) throw new Error("No open shift exists.");

    const shiftRef = doc(db, "shifts", currentActiveShift.id);
    const settingsRef = doc(db, "client_settings", activeClientId);
    const zReportRef = doc(collection(db, "z_reports"));
    const cashEntries = Array.isArray(zReport?.cashEntries)
      ? zReport.cashEntries
      : [];
    const creditEntries = Array.isArray(zReport?.creditEntries)
      ? zReport.creditEntries
      : [];
    const bankEntries = Array.isArray(zReport?.bankEntries)
      ? zReport.bankEntries
      : Array.isArray(zReport?.cardEntries)
        ? zReport.cardEntries
        : [];
    const bankTotal =
      zReport?.bankTotal != null && zReport.bankTotal !== ""
        ? num(zReport.bankTotal)
        : num(zReport?.cardTotal) + num(zReport?.qrTotal);
    const creditTransactionRefs = creditEntries.map(() =>
      doc(collection(db, "transactions"))
    );
    const savedAtMs = Date.now();
    const businessDate = String(
      zReport?.businessDate || currentActiveShift.businessDate || ""
    ).trim();

    if (!businessDate) throw new Error("Business date is required.");
    // One Z-report per day — identity is the business date (no terminal UI).
    const reportNo = String(zReport?.reportNo || businessDate).trim() || businessDate;
    const terminalId = String(zReport?.terminalId || "DAY").trim() || "DAY";
    const amountFields = [
      ["opening float", zReport.openingFloat],
      ["closing cash counted", closingCashCounted],
      ["gross sales", zReport.grossSales],
      ["net sales", zReport.netSales],
      ["cash total", zReport.cashTotal],
      ["bank total", bankTotal],
      ["credit sales total", zReport.creditSalesTotal],
    ];
    for (const [label, value] of amountFields) {
      if (num(value) < 0) throw new Error(`${label} cannot be negative.`);
    }
    if (
      toCents(zReport.grossSales) !==
      toCents(zReport.netSales) + toCents(zReport.creditSalesTotal)
    ) {
      throw new Error(
        "Gross Sales must equal Net Sales plus Credit Sales Total."
      );
    }
    if (cashEntries.length > 100) {
      throw new Error("A shift cannot contain more than 100 cash entries.");
    }
    if (creditEntries.length > 100) {
      throw new Error("A shift cannot contain more than 100 credit entries.");
    }
    if (bankEntries.length > 100) {
      throw new Error("A shift cannot contain more than 100 bank entries.");
    }
    for (const entry of cashEntries) {
      if (!String(entry?.partyId || "").trim()) {
        throw new Error("Every cash entry requires a customer.");
      }
      if (num(entry?.amount) <= 0) {
        throw new Error("Every cash entry amount must be greater than zero.");
      }
    }
    for (const entry of creditEntries) {
      if (!String(entry?.partyId || "").trim()) {
        throw new Error("Every credit entry requires a customer.");
      }
      if (num(entry?.amount) <= 0) {
        throw new Error("Every credit entry amount must be greater than zero.");
      }
    }
    for (const entry of bankEntries) {
      if (!String(entry?.bankAccountId || "").trim()) {
        throw new Error("Every bank entry requires a bank account.");
      }
      if (num(entry?.amount) <= 0) {
        throw new Error("Every bank entry amount must be greater than zero.");
      }
    }
    if (
      cashEntries.reduce((sum, entry) => sum + toCents(entry.amount), 0) !==
      toCents(zReport.cashTotal)
    ) {
      throw new Error(
        "The individual cash entries must equal the Cash Total."
      );
    }
    if (
      creditEntries.reduce((sum, entry) => sum + toCents(entry.amount), 0) !==
      toCents(zReport.creditSalesTotal)
    ) {
      throw new Error(
        "The individual credit entries must equal the Credit Sales Total."
      );
    }
    if (
      bankEntries.reduce((sum, entry) => sum + toCents(entry.amount), 0) !==
      toCents(bankTotal)
    ) {
      throw new Error(
        "The individual bank entries must equal the Bank Total."
      );
    }

    console.time("Shift Operation: Save Z-Report");
    let transactionAttempts = 0;
    try {
      await runTransaction(db, async (tx) => {
        transactionAttempts += 1;
        const uniquePartyIds = Array.from(
          new Set([
            ...cashEntries.map((entry) => String(entry.partyId)),
            ...creditEntries.map((entry) => String(entry.partyId)),
          ])
        );
        const uniqueBankAccountIds = Array.from(
          new Set(bankEntries.map((entry) => String(entry.bankAccountId)))
        );
        const partyRefs = uniquePartyIds.map((partyId) =>
          doc(db, "parties", partyId)
        );
        const bankAccountRefs = uniqueBankAccountIds.map((accountId) =>
          doc(db, "bank_accounts", accountId)
        );
        const [settingsSnap, shiftSnap, ...lookups] = await Promise.all([
          tx.get(settingsRef),
          tx.get(shiftRef),
          ...partyRefs.map((partyRef) => tx.get(partyRef)),
          ...bankAccountRefs.map((bankRef) => tx.get(bankRef)),
        ]);
        const uniquePartySnapshots = lookups.slice(0, partyRefs.length);
        const bankAccountSnapshots = lookups.slice(partyRefs.length);
        const partySnapshotById = new Map(
          uniquePartySnapshots.map((snapshot) => [snapshot.id, snapshot])
        );
        const bankAccountSnapshotById = new Map(
          bankAccountSnapshots.map((snapshot) => [snapshot.id, snapshot])
        );

        if (!shiftSnap.exists() || shiftSnap.data()?.status !== "OPEN") {
          throw new Error("This shift is no longer open.");
        }
        if (shiftSnap.data()?.clientId !== activeClientId) {
          throw new Error("Shift belongs to another shop.");
        }
        if (
          settingsSnap.data()?.activeShiftId &&
          settingsSnap.data()?.activeShiftId !== shiftRef.id
        ) {
          throw new Error("A different shift is active for this shop.");
        }

        const normalizedCashEntries = cashEntries.map((entry) => {
          const partySnapshot = partySnapshotById.get(String(entry.partyId));
          const party = partySnapshot.data();
          const partyType = String(party?.type || "").trim().toLowerCase();
          if (
            !partySnapshot.exists() ||
            party?.clientId !== activeClientId ||
            !["customer", "both"].includes(partyType)
          ) {
            throw new Error("A cash entry contains an invalid customer.");
          }
          return {
            partyId: partySnapshot.id,
            partyName: String(party.name || entry.partyName || "").trim(),
            amount: num(entry.amount),
          };
        });

        const normalizedCreditEntries = creditEntries.map((entry, index) => {
          const partySnapshot = partySnapshotById.get(String(entry.partyId));
          const party = partySnapshot.data();
          const partyType = String(party?.type || "").trim().toLowerCase();
          if (
            !partySnapshot.exists() ||
            party?.clientId !== activeClientId ||
            !["customer", "both"].includes(partyType)
          ) {
            throw new Error("A credit entry contains an invalid customer.");
          }
          return {
            partyId: partySnapshot.id,
            partyName: String(party.name || entry.partyName || "").trim(),
            partyType: party.type || "Customer",
            amount: num(entry.amount),
            transactionId: creditTransactionRefs[index].id,
          };
        });

        const normalizedBankEntries = bankEntries.map((entry) => {
          const accountSnapshot = bankAccountSnapshotById.get(
            String(entry.bankAccountId)
          );
          const account = accountSnapshot?.data();
          if (
            !accountSnapshot?.exists() ||
            account?.clientId !== activeClientId ||
            account?.isActive === false
          ) {
            throw new Error("A bank entry contains an invalid bank account.");
          }
          return {
            bankAccountId: accountSnapshot.id,
            bankAccountName: String(
              account.accountName || entry.bankAccountName || ""
            ).trim(),
            amount: num(entry.amount),
          };
        });

        tx.set(zReportRef, {
          clientId: activeClientId,
          shiftId: shiftRef.id,
          reportNo,
          terminalId,
          businessDate,
          businessDateAt: toBusinessDate(businessDate),
          grossSales: num(zReport.grossSales),
          netSales: num(zReport.netSales),
          cashTotal: num(zReport.cashTotal),
          bankTotal,
          // Legacy mirrors so older EOD/report readers stay correct.
          cardTotal: bankTotal,
          qrTotal: 0,
          creditSalesTotal: num(zReport.creditSalesTotal),
          cashIncludesExternal: zReport.cashIncludesExternal === true,
          bankIncludesExternal: zReport.bankIncludesExternal === true,
          openingFloat: num(zReport.openingFloat),
          closingCashCounted: num(closingCashCounted),
          shiftOpenedAtMs: num(shiftSnap.data()?.openedAtMs),
          shiftStatus: "OPEN",
          cashEntries: normalizedCashEntries,
          creditEntries: normalizedCreditEntries.map(
            ({ partyId, partyName, amount, transactionId }) => ({
              partyId,
              partyName,
              amount,
              transactionId,
            })
          ),
          bankEntries: normalizedBankEntries,
          cardEntries: normalizedBankEntries,
          source: "manual",
          createdBy: user.uid,
          createdAt: serverTimestamp(),
          createdAtMs: savedAtMs,
        });

        normalizedCreditEntries.forEach((entry, index) => {
          tx.set(creditTransactionRefs[index], {
            ...buildTransactionPayload({
              clientId: activeClientId,
              date: businessDate,
              type: "sales",
              category: "Credit Sale",
              mode: "CREDIT",
              partyType: entry.partyType,
              partyId: entry.partyId,
              partyName: entry.partyName,
              description: `Z-Report ${businessDate} credit sale`,
              amountBeforeTax: entry.amount,
              totalAmount: entry.amount,
              amountIn: entry.amount,
              amountOut: 0,
              status: "POSTED",
              source: "z_report_credit",
              refType: "z_report",
              refId: zReportRef.id,
              shiftId: shiftRef.id,
            }),
            createdBy: user.uid,
            createdAt: serverTimestamp(),
          });
        });

        // Keep shift OPEN; only refresh opening float from the latest Z entry.
        tx.update(shiftRef, {
          openingFloat: num(zReport.openingFloat),
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
        });
      });

      return { shiftId: shiftRef.id, zReportId: zReportRef.id };
    } finally {
      console.debug(
        "Shift Operation: Save Z-Report transaction attempts",
        transactionAttempts
      );
      console.timeEnd("Shift Operation: Save Z-Report");
    }
  }

  /** @deprecated Prefer saveZReport + closeShiftWithoutZReport. Kept for compatibility. */
  async function closeShiftWithZReport(args) {
    const result = await saveZReport(args);
    await closeShiftWithoutZReport();
    return result;
  }

  async function closeShiftWithoutZReport() {
    if (!activeClientId) throw new Error("Select an active shop first.");
    if (!user?.uid) throw new Error("You must be signed in.");
    if (!currentActiveShift?.id) throw new Error("No open shift exists.");

    const shiftRef = doc(db, "shifts", currentActiveShift.id);
    const settingsRef = doc(db, "client_settings", activeClientId);
    const closedAtMs = Date.now();

    console.time("Shift Operation: Close Without Z-Report");
    let transactionAttempts = 0;
    try {
      await runTransaction(db, async (tx) => {
        transactionAttempts += 1;
        const shiftSnap = await tx.get(shiftRef);

        if (
          !shiftSnap.exists() ||
          shiftSnap.data()?.clientId !== activeClientId ||
          shiftSnap.data()?.status !== "OPEN"
        ) {
          throw new Error("The selected shift is no longer open.");
        }

        // Settings write happens after the shift read.
        await tx.get(settingsRef);

        tx.update(shiftRef, {
          closedBy: user.uid,
          closedAt: serverTimestamp(),
          closedAtMs,
          closingCashCounted: null,
          zReportId: null,
          status: "CLOSED",
          closedWithoutZReport: true,
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
        });

        tx.set(
          settingsRef,
          {
            clientId: activeClientId,
            activeShiftId: null,
            lastClosedShiftId: shiftRef.id,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      });

      return { shiftId: shiftRef.id };
    } finally {
      console.debug(
        "Shift Operation: Close Without Z-Report transaction attempts",
        transactionAttempts
      );
      console.timeEnd("Shift Operation: Close Without Z-Report");
    }
  }

  async function updateClosedZReport({
    zReportId,
    closingCashCounted,
    zReport,
  }) {
    if (!activeClientId) throw new Error("Select an active shop first.");
    if (!user?.uid) throw new Error("You must be signed in.");
    if (!String(zReportId || "").trim()) {
      throw new Error("Z-report ID is required.");
    }

    const cashEntries = Array.isArray(zReport?.cashEntries)
      ? zReport.cashEntries
      : [];
    const creditEntries = Array.isArray(zReport?.creditEntries)
      ? zReport.creditEntries
      : [];
    const bankEntries = Array.isArray(zReport?.bankEntries)
      ? zReport.bankEntries
      : Array.isArray(zReport?.cardEntries)
        ? zReport.cardEntries
        : [];
    const bankTotal =
      zReport?.bankTotal != null && zReport.bankTotal !== ""
        ? num(zReport.bankTotal)
        : num(zReport?.cardTotal) + num(zReport?.qrTotal);
    const replacementTransactionRefs = creditEntries.map(() =>
      doc(collection(db, "transactions"))
    );
    const businessDate = String(zReport?.businessDate || "").trim();

    if (!businessDate) throw new Error("Business date is required.");
    const reportNo = String(zReport?.reportNo || businessDate).trim() || businessDate;
    const terminalId = String(zReport?.terminalId || "DAY").trim() || "DAY";
    const amountFields = [
      ["opening float", zReport.openingFloat],
      ["closing cash counted", closingCashCounted],
      ["gross sales", zReport.grossSales],
      ["net sales", zReport.netSales],
      ["cash total", zReport.cashTotal],
      ["bank total", bankTotal],
      ["credit sales total", zReport.creditSalesTotal],
    ];
    for (const [label, value] of amountFields) {
      if (num(value) < 0) throw new Error(`${label} cannot be negative.`);
    }
    if (
      toCents(zReport.grossSales) !==
      toCents(zReport.netSales) + toCents(zReport.creditSalesTotal)
    ) {
      throw new Error(
        "Gross Sales must equal Net Sales plus Credit Sales Total."
      );
    }
    if (cashEntries.length > 100) {
      throw new Error("A Z-report cannot contain more than 100 cash entries.");
    }
    if (creditEntries.length > 100) {
      throw new Error("A Z-report cannot contain more than 100 credit entries.");
    }
    if (bankEntries.length > 100) {
      throw new Error("A Z-report cannot contain more than 100 bank entries.");
    }
    for (const entry of cashEntries) {
      if (!String(entry?.partyId || "").trim()) {
        throw new Error("Every cash entry requires a customer.");
      }
      if (num(entry?.amount) <= 0) {
        throw new Error("Every cash entry amount must be greater than zero.");
      }
    }
    for (const entry of creditEntries) {
      if (!String(entry?.partyId || "").trim()) {
        throw new Error("Every credit entry requires a customer.");
      }
      if (num(entry?.amount) <= 0) {
        throw new Error("Every credit entry amount must be greater than zero.");
      }
    }
    for (const entry of bankEntries) {
      if (!String(entry?.bankAccountId || "").trim()) {
        throw new Error("Every bank entry requires a bank account.");
      }
      if (num(entry?.amount) <= 0) {
        throw new Error("Every bank entry amount must be greater than zero.");
      }
    }
    if (
      cashEntries.reduce((sum, entry) => sum + toCents(entry.amount), 0) !==
      toCents(zReport.cashTotal)
    ) {
      throw new Error(
        "The individual cash entries must equal the Cash Total."
      );
    }
    if (
      creditEntries.reduce((sum, entry) => sum + toCents(entry.amount), 0) !==
      toCents(zReport.creditSalesTotal)
    ) {
      throw new Error(
        "The individual credit entries must equal the Credit Sales Total."
      );
    }
    if (
      bankEntries.reduce((sum, entry) => sum + toCents(entry.amount), 0) !==
      toCents(bankTotal)
    ) {
      throw new Error(
        "The individual bank entries must equal the Bank Total."
      );
    }

    const zReportRef = doc(db, "z_reports", zReportId);
    console.time("Shift Operation: Update Z-Report");
    let transactionAttempts = 0;
    try {
      await runTransaction(db, async (tx) => {
        transactionAttempts += 1;
        const zReportSnapshot = await tx.get(zReportRef);
        if (!zReportSnapshot.exists()) {
          throw new Error("Z-report no longer exists.");
        }

        const existingZReport = zReportSnapshot.data();
        if (existingZReport.clientId !== activeClientId) {
          throw new Error("Z-report belongs to another shop.");
        }
        const shiftRef = doc(db, "shifts", existingZReport.shiftId);
        const oldTransactionRefs = (
          Array.isArray(existingZReport.creditEntries)
            ? existingZReport.creditEntries
            : []
        )
          .map((entry) => String(entry?.transactionId || "").trim())
          .filter(Boolean)
          .map((transactionId) => doc(db, "transactions", transactionId));
        const uniquePartyIds = Array.from(
          new Set([
            ...cashEntries.map((entry) => String(entry.partyId)),
            ...creditEntries.map((entry) => String(entry.partyId)),
          ])
        );
        const uniqueBankAccountIds = Array.from(
          new Set(bankEntries.map((entry) => String(entry.bankAccountId)))
        );
        const partyRefs = uniquePartyIds.map((partyId) =>
          doc(db, "parties", partyId)
        );
        const bankAccountRefs = uniqueBankAccountIds.map((accountId) =>
          doc(db, "bank_accounts", accountId)
        );

        const allSnapshots = await Promise.all([
          tx.get(shiftRef),
          ...oldTransactionRefs.map((transactionRef) => tx.get(transactionRef)),
          ...partyRefs.map((partyRef) => tx.get(partyRef)),
          ...bankAccountRefs.map((bankRef) => tx.get(bankRef)),
        ]);
        const shiftSnapshot = allSnapshots[0];
        const oldTransactionSnapshots = allSnapshots.slice(
          1,
          1 + oldTransactionRefs.length
        );
        const partySnapshots = allSnapshots.slice(
          1 + oldTransactionRefs.length,
          1 + oldTransactionRefs.length + partyRefs.length
        );
        const bankAccountSnapshots = allSnapshots.slice(
          1 + oldTransactionRefs.length + partyRefs.length
        );
        const partySnapshotById = new Map(
          partySnapshots.map((snapshot) => [snapshot.id, snapshot])
        );
        const bankAccountSnapshotById = new Map(
          bankAccountSnapshots.map((snapshot) => [snapshot.id, snapshot])
        );

        const shiftData = shiftSnapshot.data() || {};
        const shiftStatus = String(shiftData.status || "").trim().toUpperCase();
        // Z-reports and shift close are separate: shifts are often closed with
        // zReportId left null (or never set). Allow edit when the Z-report's
        // shiftId points at this shift, and any stored zReportId matches.
        const shiftZReportId = String(shiftData.zReportId || "").trim();
        const shiftLinkedOk =
          !shiftZReportId || shiftZReportId === String(zReportId || "").trim();

        if (
          !shiftSnapshot.exists() ||
          shiftData.clientId !== activeClientId ||
          !["CLOSED", "OPEN"].includes(shiftStatus) ||
          !shiftLinkedOk
        ) {
          throw new Error(
            shiftZReportId && !shiftLinkedOk
              ? "This Z-report is not linked to the selected shift."
              : "The linked shift could not be validated for editing."
          );
        }
        if (
          shiftData.businessDate &&
          businessDate !== shiftData.businessDate
        ) {
          throw new Error("Z-report date must match the linked shift date.");
        }

      oldTransactionSnapshots.forEach((snapshot) => {
        if (!snapshot.exists()) return;
        const existingTransaction = snapshot.data();
        if (
          existingTransaction.clientId !== activeClientId ||
          existingTransaction.refType !== "z_report" ||
          existingTransaction.refId !== zReportId ||
          existingTransaction.source !== "z_report_credit"
        ) {
          throw new Error("A linked credit transaction failed validation.");
        }
      });

      const normalizedCashEntries = cashEntries.map((entry) => {
        const partySnapshot = partySnapshotById.get(String(entry.partyId));
        const party = partySnapshot.data();
        const partyType = String(party?.type || "").trim().toLowerCase();
        if (
          !partySnapshot.exists() ||
          party?.clientId !== activeClientId ||
          !["customer", "both"].includes(partyType)
        ) {
          throw new Error("A cash entry contains an invalid customer.");
        }
        return {
          partyId: partySnapshot.id,
          partyName: String(party.name || entry.partyName || "").trim(),
          amount: num(entry.amount),
        };
      });

      const normalizedCreditEntries = creditEntries.map((entry, index) => {
        const partySnapshot = partySnapshotById.get(String(entry.partyId));
        const party = partySnapshot.data();
        const partyType = String(party?.type || "").trim().toLowerCase();
        if (
          !partySnapshot.exists() ||
          party?.clientId !== activeClientId ||
          !["customer", "both"].includes(partyType)
        ) {
          throw new Error("A credit entry contains an invalid customer.");
        }
        return {
          partyId: partySnapshot.id,
          partyName: String(party.name || entry.partyName || "").trim(),
          partyType: party.type || "Customer",
          amount: num(entry.amount),
          transactionId: replacementTransactionRefs[index].id,
        };
      });

      const normalizedBankEntries = bankEntries.map((entry) => {
        const accountSnapshot = bankAccountSnapshotById.get(
          String(entry.bankAccountId)
        );
        const account = accountSnapshot?.data();
        if (
          !accountSnapshot?.exists() ||
          account?.clientId !== activeClientId ||
          account?.isActive === false
        ) {
          throw new Error("A bank entry contains an invalid bank account.");
        }
        return {
          bankAccountId: accountSnapshot.id,
          bankAccountName: String(
            account.accountName || entry.bankAccountName || ""
          ).trim(),
          amount: num(entry.amount),
        };
      });

      oldTransactionRefs.forEach((transactionRef) => tx.delete(transactionRef));
      normalizedCreditEntries.forEach((entry, index) => {
        tx.set(replacementTransactionRefs[index], {
          ...buildTransactionPayload({
            clientId: activeClientId,
            date: businessDate,
            type: "sales",
            category: "Credit Sale",
            mode: "CREDIT",
            partyType: entry.partyType,
            partyId: entry.partyId,
            partyName: entry.partyName,
            description: `Z-Report ${businessDate} credit sale`,
            amountBeforeTax: entry.amount,
            totalAmount: entry.amount,
            amountIn: entry.amount,
            amountOut: 0,
            status: "POSTED",
            source: "z_report_credit",
            refType: "z_report",
            refId: zReportId,
            shiftId: existingZReport.shiftId,
          }),
          createdBy: user.uid,
          createdAt: serverTimestamp(),
        });
      });

      tx.update(zReportRef, {
        reportNo,
        terminalId,
        businessDate,
        businessDateAt: toBusinessDate(businessDate),
        grossSales: num(zReport.grossSales),
        netSales: num(zReport.netSales),
        cashTotal: num(zReport.cashTotal),
        bankTotal,
        cardTotal: bankTotal,
        qrTotal: 0,
        creditSalesTotal: num(zReport.creditSalesTotal),
        cashIncludesExternal: zReport.cashIncludesExternal === true,
        bankIncludesExternal: zReport.bankIncludesExternal === true,
        openingFloat: num(zReport.openingFloat),
        closingCashCounted: num(closingCashCounted),
        shiftOpenedAtMs: num(shiftSnapshot.data()?.openedAtMs),
        shiftStatus: String(shiftSnapshot.data()?.status || "CLOSED")
          .trim()
          .toUpperCase() || "CLOSED",
        voidTotal: deleteField(),
        cashEntries: normalizedCashEntries,
        creditEntries: normalizedCreditEntries.map(
          ({ partyId, partyName, amount, transactionId }) => ({
            partyId,
            partyName,
            amount,
            transactionId,
          })
        ),
        bankEntries: normalizedBankEntries,
        cardEntries: normalizedBankEntries,
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      });
      tx.update(shiftRef, {
        openingFloat: num(zReport.openingFloat),
        closingCashCounted: num(closingCashCounted),
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
      });
      });
    } finally {
      console.debug(
        "Shift Operation: Update Z-Report transaction attempts",
        transactionAttempts
      );
      console.timeEnd("Shift Operation: Update Z-Report");
    }
  }

  async function updateActiveShiftBusinessDate(nextBusinessDate) {
    if (!activeClientId) throw new Error("Select an active shop first.");
    if (!user?.uid) throw new Error("You must be signed in.");
    if (!currentActiveShift?.id) throw new Error("No open shift exists.");

    const cleanDate = String(nextBusinessDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      throw new Error("Select a valid business date.");
    }
    if (cleanDate === currentActiveShift.businessDate) {
      return currentActiveShift.id;
    }
    if (unsavedWorkLabels.length) {
      throw new Error(
        `Save or clear unsaved work before changing the shift date: ${unsavedWorkLabels.join(
          ", "
        )}.`
      );
    }

    const shiftRef = doc(db, "shifts", currentActiveShift.id);
    console.time("Shift Operation: Update Business Date");
    try {
      await runTransaction(db, async (tx) => {
        const shiftSnap = await tx.get(shiftRef);
        if (
          !shiftSnap.exists() ||
          shiftSnap.data()?.clientId !== activeClientId ||
          shiftSnap.data()?.status !== "OPEN"
        ) {
          throw new Error("The active shift is no longer open.");
        }
        tx.update(shiftRef, {
          businessDate: cleanDate,
          businessDateAt: toBusinessDate(cleanDate),
          updatedBy: user.uid,
          updatedAt: serverTimestamp(),
        });
      });
      return shiftRef.id;
    } finally {
      console.timeEnd("Shift Operation: Update Business Date");
    }
  }

  return (
    <ShiftContext.Provider
      value={{
        activeShift: currentActiveShift,
        loadingShift,
        shiftError,
        unsavedWork,
        unsavedWorkLabels,
        setUnsavedWork,
        openShift,
        saveZReport,
        closeShiftWithZReport,
        closeShiftWithoutZReport,
        updateClosedZReport,
        updateActiveShiftBusinessDate,
      }}
    >
      {children}
    </ShiftContext.Provider>
  );
}
