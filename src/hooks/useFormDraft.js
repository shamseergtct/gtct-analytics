import { useCallback, useRef } from "react";
import {
  clearFormDraft,
  getFormDraft,
  setFormDraft,
} from "../utils/formDraftStore.js";

/**
 * In-memory form drafts for SPA navigation.
 * Survives route changes; cleared on full page reload or clearDraft().
 */
export function useFormDraft(key) {
  const cacheRef = useRef({ key: null, data: null });
  if (cacheRef.current.key !== key) {
    cacheRef.current = {
      key,
      data: key ? getFormDraft(key) : null,
    };
  }

  const syncDraft = useCallback(
    (snapshot) => {
      if (!key) return;
      setFormDraft(key, snapshot);
    },
    [key]
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
