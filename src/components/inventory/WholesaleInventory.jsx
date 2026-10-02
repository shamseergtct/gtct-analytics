import ItemEntryShell, { CoreItemFields } from "./ItemEntryShell.jsx";
import { FIELD_CLASS, LABEL_CLASS } from "./inventoryStyles.js";

/** Wholesale / retail hybrid — carton conversion + dual pricing. */
export default function WholesaleInventory(props) {
  const {
    saveItem,
    unitsPerCarton,
    setUnitsPerCarton,
    wholesalePrice,
    setWholesalePrice,
  } = props;

  return (
    <ItemEntryShell
      {...props}
      onSubmit={saveItem}
      badge={<span className="text-violet-400/80">Wholesale / retail hybrid</span>}
      title="Item Entry"
      subtitle="Piece & carton conversion with retail and wholesale price tiers."
    >
      <CoreItemFields
        {...props}
        itemCodePlaceholder="e.g. WH-001"
        sellingLabel="Retail Price"
      />

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Pieces per Carton</label>
        <input
          type="number"
          inputMode="decimal"
          min="1"
          step="1"
          value={unitsPerCarton}
          onChange={(e) => setUnitsPerCarton(e.target.value)}
          className={`${FIELD_CLASS} text-right`}
          placeholder="12"
        />
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Wholesale Price (per piece)</label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={wholesalePrice}
          onChange={(e) => setWholesalePrice(e.target.value)}
          className={`${FIELD_CLASS} text-right`}
          placeholder="0.00"
        />
      </div>

      <div className="md:col-span-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
        Stock is tracked in <span className="text-slate-200">pieces</span>. Sales
        carton mode multiplies by pieces-per-carton and can use the wholesale tier.
      </div>
    </ItemEntryShell>
  );
}
