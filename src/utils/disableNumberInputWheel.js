/**
 * Prevent mouse wheel / trackpad scroll from changing focused number inputs.
 * Browsers otherwise increment/decrement type="number" values while scrolling.
 */
export function installDisableNumberInputWheel() {
  const onWheel = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== "number") return;
    if (document.activeElement !== target) return;
    event.preventDefault();
  };

  document.addEventListener("wheel", onWheel, { passive: false });
  return () => document.removeEventListener("wheel", onWheel);
}
