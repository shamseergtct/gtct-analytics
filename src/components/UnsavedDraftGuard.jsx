import { useEffect } from "react";
import { useClient } from "../context/ClientContext";
import { useShift } from "../context/shift-context";
import { listFormDrafts } from "../utils/formDraftStore.js";

/**
 * Silent guard: warn only when the browser is about to refresh/close
 * with unsaved entry drafts. Does not show an always-on banner.
 * Drafts still restore automatically when you reopen the module.
 */
export default function UnsavedDraftGuard() {
  const { activeClientId } = useClient();
  const { unsavedWork } = useShift();

  useEffect(() => {
    function hasUnsavedDrafts() {
      if (!activeClientId) return false;
      const drafts = listFormDrafts().some((d) =>
        String(d.key).includes(`:${activeClientId}`)
      );
      if (drafts) return true;
      return Object.values(unsavedWork || {}).some(Boolean);
    }

    function onBeforeUnload(event) {
      if (!hasUnsavedDrafts()) return;
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeClientId, unsavedWork]);

  return null;
}
