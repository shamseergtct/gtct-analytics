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
      badge={<span className="text-sky-400/80">Retail inventory</span>}
      title="Item Entry"
      subtitle="Barcode-ready catalog with reorder level and batch / expiry tracking."
    >
      <CoreItemFields
        {...props}
        itemCodeLabel="Item Code / SKU"
        itemCodePlaceholder="e.g. ITM-001"
      />

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Barcode</label>
        <input
          value={barcode || ""}
          onChange={(e) => setBarcode(e.target.value)}
          className={`${FIELD_CLASS} font-mono`}
          placeholder="Scan or type barcode"
        />
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Min Stock / Reorder Level</label>
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
        <label className={LABEL_CLASS}>Batch No (optional)</label>
        <input
          value={batchNo || ""}
          onChange={(e) => setBatchNo(e.target.value)}
          className={FIELD_CLASS}
          placeholder="Batch / lot"
        />
      </div>

      <div className="min-w-0">
        <label className={LABEL_CLASS}>Expiry Date (optional)</label>
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
