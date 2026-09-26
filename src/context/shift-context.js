import { createContext, useContext, useEffect } from "react";

export const ShiftContext = createContext(null);

export function useShift() {
  const context = useContext(ShiftContext);
  if (!context) throw new Error("useShift must be used inside <ShiftProvider />");
  return context;
}

/**
 * Register unsaved draft work so shift date changes can be blocked.
 * Dirty flags persist across route changes until the module reports clean again.
 */
export function useUnsavedWork(moduleId, label, isDirty) {
  const { setUnsavedWork } = useShift();

  useEffect(() => {
    setUnsavedWork(moduleId, isDirty ? label : null);
  }, [isDirty, label, moduleId, setUnsavedWork]);
}
