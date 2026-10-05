import { useCallback, useRef } from "react";
import {
  clearFormDraft,
  getFormDraft,
  setFormDraft,
} from "../utils/formDraftStore.js";

/**
 * Form drafts for SPA navigation + session refresh recovery.
 * Survives route changes and full page reload (sessionStorage).
 *
 * After mount or when `draftKey` changes, the page must call
 * `markDraftHydrated()` (usually from a useLayoutEffect that also
 * applies `readDraft()` into local state). `syncDraft` is a no-op until
 * then, so a shop switch cannot overwrite another shop's draft.
 *
 * @param {string} key
 * @param {{ label?: string, path?: string, moduleId?: string }} [meta]
 */
export function useFormDraft(key, meta = {}) {
  const hydratedKeyRef = useRef(null);
  const cacheRef = useRef({ key: null, data: null });

  if (cacheRef.current.key !== key) {
    cacheRef.current = {
      key,
      data: key ? getFormDraft(key) : null,
    };
  }

  const markDraftHydrated = useCallback(() => {
    hydratedKeyRef.current = key;
  }, [key]);

  const syncDraft = useCallback(
    (snapshot, options = {}) => {
      if (!key) return;
      // Block writes until this key's draft has been applied into form state.
      if (hydratedKeyRef.current !== key) return;
      const dirty = options.dirty !== false;
      if (!dirty) {
        clearFormDraft(key);
        cacheRef.current = { key, data: null };
        return;
      }
      setFormDraft(key, snapshot, {
        label: meta.label,
        path: meta.path,
        moduleId: meta.moduleId,
      });
      cacheRef.current = { key, data: snapshot };
    },
    [key, meta.label, meta.path, meta.moduleId]
  );

  const clearDraft = useCallback(() => {
    if (!key) return;
    clearFormDraft(key);
    cacheRef.current = { key, data: null };
  }, [key]);

  const readDraft = useCallback(() => {
    if (!key) return null;
    return getFormDraft(key);
  }, [key]);

  return {
    initialDraft: cacheRef.current.data,
    draftKey: key,
    markDraftHydrated,
    readDraft,
    syncDraft,
    clearDraft,
  };
}
