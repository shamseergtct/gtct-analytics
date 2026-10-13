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
      badge={<span className="text-violet-400/80">Wholesale / retail</span>}
      title="Item Entry"
    >
      <CoreItemFields
        {...props}
        itemCodePlaceholder="Code"
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
        <label className={LABEL_CLASS}>Wholesale Price</label>
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
    </ItemEntryShell>
  );
}
