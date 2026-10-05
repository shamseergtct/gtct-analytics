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
 * @param {string} key
 * @param {{ label?: string, path?: string, moduleId?: string }} [meta]
 */
export function useFormDraft(key, meta = {}) {
  const cacheRef = useRef({ key: null, data: null });
  if (cacheRef.current.key !== key) {
    cacheRef.current = {
      key,
      data: key ? getFormDraft(key) : null,
    };
  }

  const syncDraft = useCallback(
    (snapshot, options = {}) => {
      if (!key) return;
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

  return {
    initialDraft: cacheRef.current.data,
    syncDraft,
    clearDraft,
  };
}
