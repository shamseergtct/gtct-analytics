/** Shared subcategory helpers for inventory + staff filters. */

export function normalizeSubCategory(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Distinct non-empty subcategories from a catalog, sorted. */
export function listItemSubCategories(items = []) {
  const set = new Set();
  for (const item of items) {
    const value = normalizeSubCategory(item?.subCategory);
    if (value) set.add(value);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Filter catalog by subcategory chip value.
 * @param {"all"|string|"__none__"} filter
 */
export function itemMatchesSubCategory(item, filter) {
  const selected = String(filter || "all").trim();
  if (!selected || selected === "all") return true;
  const value = normalizeSubCategory(item?.subCategory);
  if (selected === "__none__") return !value;
  return value.toLowerCase() === selected.toLowerCase();
}
