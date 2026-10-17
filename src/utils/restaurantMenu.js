/** Sort helpers for Restaurant Sales menu layout (inventory.menuSortOrder). */

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
