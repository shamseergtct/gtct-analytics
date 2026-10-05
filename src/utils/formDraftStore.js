/**
 * Form drafts for SPA navigation + session refresh recovery.
 * In-memory Map for fast route switches; mirrored to sessionStorage.
 */

const drafts = new Map();
const STORAGE_PREFIX = "gtct_form_draft:";
const INDEX_KEY = "gtct_form_draft_index";

function readIndex() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(INDEX_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  if (typeof window === "undefined") return;
  try {
    if (!index || !Object.keys(index).length) {
      window.sessionStorage.removeItem(INDEX_KEY);
      return;
    }
    window.sessionStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // session persistence is optional
  }
}

function storageKey(key) {
  return `${STORAGE_PREFIX}${key}`;
}

function hydrateFromStorage(key) {
  if (!key || typeof window === "undefined") return null;
  if (drafts.has(key)) return drafts.get(key);
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    drafts.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function getFormDraft(key) {
  if (!key) return null;
  const entry = hydrateFromStorage(key);
  return entry?.data ?? null;
}

export function getFormDraftMeta(key) {
  if (!key) return null;
  const entry = hydrateFromStorage(key);
  return entry?.meta ?? null;
}

/**
 * @param {string} key
 * @param {unknown} value - draft payload; null clears
 * @param {{ label?: string, path?: string, moduleId?: string } | null} meta
 */
export function setFormDraft(key, value, meta = null) {
  if (!key) return;
  if (value == null) {
    clearFormDraft(key);
    return;
  }

  const entry = {
    data: value,
    meta: {
      label: meta?.label || key,
      path: meta?.path || "",
      moduleId: meta?.moduleId || "",
    },
    updatedAt: Date.now(),
  };
  drafts.set(key, entry);

  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(storageKey(key), JSON.stringify(entry));
      const index = readIndex();
      index[key] = {
        label: entry.meta.label,
        path: entry.meta.path,
        moduleId: entry.meta.moduleId,
        updatedAt: entry.updatedAt,
      };
      writeIndex(index);
    } catch {
      // ignore quota / private mode
    }
  }
}

export function clearFormDraft(key) {
  if (!key) return;
  drafts.delete(key);
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(storageKey(key));
      const index = readIndex();
      if (key in index) {
        delete index[key];
        writeIndex(index);
      }
    } catch {
      // ignore
    }
  }
}

/** List persisted draft index entries (survives refresh). */
export function listFormDrafts() {
  const index = readIndex();
  return Object.entries(index)
    .map(([key, meta]) => ({
      key,
      label: meta?.label || key,
      path: meta?.path || "",
      moduleId: meta?.moduleId || "",
      updatedAt: meta?.updatedAt || 0,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function clearAllFormDrafts() {
  const keys = Object.keys(readIndex());
  keys.forEach((key) => clearFormDraft(key));
  drafts.clear();
}
