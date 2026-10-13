import { listItemSubCategories } from "../../utils/inventorySubCategory.js";

/**
 * Compact subcategory filter for staff Today / Usage fast entry.
 * @param {"all"|string|"__none__"} value
 */
export default function SubCategoryFilter({
  items = [],
  value = "all",
  onChange,
}) {
  const options = listItemSubCategories(items);
  const hasUncategorized = items.some(
    (item) => !String(item?.subCategory || "").trim()
  );

  if (!options.length && !hasUncategorized) return null;

  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        Sub category
      </span>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-3 py-3 text-base text-white outline-none focus:border-sky-500"
      >
        <option value="all">All sub categories</option>
        {hasUncategorized ? (
          <option value="__none__">No sub category</option>
        ) : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
