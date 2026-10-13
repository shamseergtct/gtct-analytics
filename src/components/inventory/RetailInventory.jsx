import ItemEntryShell, { CoreItemFields } from "./ItemEntryShell.jsx";
import { FIELD_CLASS, LABEL_CLASS } from "./inventoryStyles.js";

/** Retail grocery/stationery — barcode, reorder level, batch/expiry. */
export default function RetailInventory(props) {
  const {
    saveItem,
    barcode,
    setBarcode,
    minStock,
    setMinStock,
    batchNo,
    setBatchNo,
    expiryDate,
    setExpiryDate,
  } = props;

  return (
    <ItemEntryShell
      {...props}
      onSubmit={saveItem}
      badge={<span className="text-sky-400/80">Retail</span>}
      title="Item Entry"
    >
      <CoreItemFields
        {...props}
        itemCodeLabel="Item Code / SKU"
        itemCodePlaceholder="Code"
      />

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Barcode</label>
        <input
          value={barcode || ""}
          onChange={(e) => setBarcode(e.target.value)}
          className={`${FIELD_CLASS} font-mono`}
          placeholder="Barcode"
        />
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Min Stock</label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={minStock}
          onChange={(e) => setMinStock(e.target.value)}
          className={`${FIELD_CLASS} text-right`}
          placeholder="0"
        />
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Batch No</label>
        <input
          value={batchNo || ""}
          onChange={(e) => setBatchNo(e.target.value)}
          className={FIELD_CLASS}
          placeholder="Batch"
        />
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Expiry Date</label>
        <input
          type="date"
          value={expiryDate || ""}
          onChange={(e) => setExpiryDate(e.target.value)}
          className={FIELD_CLASS}
        />
      </div>
    </ItemEntryShell>
  );
}
