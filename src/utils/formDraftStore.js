/**
 * In-memory form drafts for SPA navigation.
 * Survives route changes; cleared on full page reload or explicit clearFormDraft.
 */

const drafts = new Map();

export function getFormDraft(key) {
  if (!key) return null;
  return drafts.has(key) ? drafts.get(key) : null;
}

export function setFormDraft(key, value) {
  if (!key) return;
  if (value == null) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, value);
}

export function clearFormDraft(key) {
  if (!key) return;
  drafts.delete(key);
}
