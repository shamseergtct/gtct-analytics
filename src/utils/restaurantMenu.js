/** Sort helpers + menu taxonomy for Restaurant Sales (inventory fields). */

export const MENU_LABEL_MAX = 60;

export function normalizeMenuLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MENU_LABEL_MAX);
}

/** POS filter label: menuCategory, else legacy subCategory. */
export function getMenuCategoryLabel(item) {
  return (
    normalizeMenuLabel(item?.menuCategory) ||
    normalizeMenuLabel(item?.subCategory)
  );
}

export function listDistinctMenuLabels(items = [], getter) {
  const set = new Set();
  for (const item of items) {
    const value = normalizeMenuLabel(getter(item));
    if (value) set.add(value);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function getMenuSortOrder(item) {
  const n = Number(item?.menuSortOrder);
  return Number.isFinite(n) ? n : null;
}

export function compareMenuItems(a, b) {
  const ao = getMenuSortOrder(a);
  const bo = getMenuSortOrder(b);
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if (ao != null && bo == null) return -1;
  if (ao == null && bo != null) return 1;
  return String(a?.itemName || "").localeCompare(String(b?.itemName || ""), undefined, {
    sensitivity: "base",
  });
}

/** Ensure every item has a contiguous menuSortOrder 0..n-1 in current list order. */
export function assignMenuSortOrders(items) {
  return (items || []).map((item, index) => ({
    id: item.id,
    menuSortOrder: index,
  }));
}
