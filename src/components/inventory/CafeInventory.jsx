import ItemEntryShell, { CoreItemFields } from "./ItemEntryShell.jsx";
import { CAFE_UNITS, FIELD_CLASS, LABEL_CLASS } from "./inventoryStyles.js";

/** Café / restaurant item entry — base unit + recipe notes. */
export default function CafeInventory(props) {
  const {
    saveItem,
    baseUnit,
    setBaseUnit,
    recipeNotes,
    setRecipeNotes,
  } = props;

  return (
    <ItemEntryShell
      {...props}
      onSubmit={saveItem}
      badge={<span className="text-amber-400/80">Café / restaurant inventory</span>}
      title="Item Entry"
      subtitle="Menu & kitchen items. Use base units and recipe notes for prep."
    >
      <CoreItemFields {...props} itemCodePlaceholder="e.g. MENU-01" />

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Base Unit</label>
        <select
          value={baseUnit || "pcs"}
          onChange={(e) => setBaseUnit(e.target.value)}
          className={FIELD_CLASS}
        >
          {CAFE_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Quick tip</label>
        <div className="mt-1 flex h-11 items-center rounded-lg border border-slate-800 bg-slate-950/40 px-3 text-xs text-slate-400">
          Stock adjusts in Stock Update (piece/unit).
        </div>
      </div>

      <div className="md:col-span-2">
        <label className={LABEL_CLASS}>Recipe / Components (optional)</label>
        <textarea
          value={recipeNotes || ""}
          onChange={(e) => setRecipeNotes(e.target.value)}
          rows={3}
          className="box-border w-full rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          placeholder="e.g. Espresso shot × 2, milk 180ml, syrup 10ml…"
        />
      </div>
    </ItemEntryShell>
  );
}
