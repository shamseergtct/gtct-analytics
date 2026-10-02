import { ImageIcon, Upload, X } from "lucide-react";
import { LABEL_CLASS, FIELD_CLASS, INVENTORY_CATEGORIES } from "./inventoryStyles.js";

/** Shared chrome for item-entry layouts (header actions + image + footer). */
export default function ItemEntryShell({
  title,
  subtitle,
  badge,
  children,
  imagePreview,
  imageStatus,
  handleImageChange,
  entryMessage,
  savingItem,
  isEditing = false,
  cancelItemEntry,
  handleExportItems,
  openImportItems,
  closeItemEntry,
  loading,
  activeClientId,
  onSubmit,
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto mt-6 max-w-4xl rounded-xl border border-slate-700/50 bg-slate-900/80 p-6 shadow-xl shadow-black/20 backdrop-blur-sm"
    >
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          {badge ? (
            <div className="mb-1 text-xs font-medium uppercase tracking-wide">
              {badge}
            </div>
          ) : null}
          <h2 className="font-semibold text-slate-100">{title}</h2>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleExportItems}
            disabled={loading || !activeClientId}
            className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-60"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={openImportItems}
            disabled={!activeClientId}
            className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-60"
          >
            Import CSV
          </button>
          <button
            type="button"
            onClick={closeItemEntry}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close item entry"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 items-end gap-x-6 gap-y-4 md:grid-cols-2">
        {children}

        <div className="md:col-span-2">
          <label className={LABEL_CLASS}>Item Image</label>
          <div className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-slate-700 bg-slate-950/50 p-3 transition-colors hover:border-blue-500/50 hover:bg-slate-800/30 sm:flex-row sm:items-center">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
              {imagePreview ? (
                <img
                  src={imagePreview}
                  alt="Selected item preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <ImageIcon size={25} className="text-slate-600" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800 focus-within:ring-2 focus-within:ring-blue-500">
                <Upload size={16} />
                Choose Image
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="sr-only"
                />
              </label>
              <p className="mt-2 truncate text-xs text-slate-400">{imageStatus}</p>
              <p className="mt-1 text-xs text-slate-600">
                JPG, PNG or WebP up to 5 MB.
              </p>
            </div>
          </div>
        </div>
      </div>

      {entryMessage ? (
        <p className="mt-4 text-sm text-slate-300">{entryMessage}</p>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={cancelItemEntry}
          disabled={savingItem}
          className="rounded-lg border border-slate-700 bg-slate-950/50 px-5 py-2.5 font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={savingItem}
          className="transform rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow-lg shadow-blue-900/20 transition-all duration-200 hover:-translate-y-0.5 hover:bg-blue-500 disabled:translate-y-0 disabled:opacity-60"
        >
          {savingItem ? "Saving…" : isEditing ? "Update Item" : "Save Item"}
        </button>
      </div>
    </form>
  );
}

export function CoreItemFields({
  category,
  setCategory,
  categories = INVENTORY_CATEGORIES,
  itemCode,
  setItemCode,
  itemName,
  setItemName,
  cost,
  setCost,
  sellingPrice,
  setSellingPrice,
  itemCodeLabel = "Item Code",
  itemCodePlaceholder = "e.g. ITM-001",
  sellingLabel = "Selling Price",
}) {
  return (
    <>
      <div className="min-w-0">
        <label className={LABEL_CLASS}>Category</label>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className={FIELD_CLASS}
        >
          {categories.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </div>
      <div className="min-w-0">
        <label className={LABEL_CLASS}>{itemCodeLabel}</label>
        <input
          value={itemCode}
          onChange={(event) => setItemCode(event.target.value)}
          className={FIELD_CLASS}
          placeholder={itemCodePlaceholder}
          required
        />
      </div>
      <div className="md:col-span-2">
        <label className={LABEL_CLASS}>Name</label>
        <input
          value={itemName}
          onChange={(event) => setItemName(event.target.value)}
          className={FIELD_CLASS}
          placeholder="Item name"
          required
        />
      </div>
      <div className="min-w-0">
        <label className={LABEL_CLASS}>Cost</label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={cost}
          onChange={(event) => setCost(event.target.value)}
          className={`${FIELD_CLASS} text-right`}
          placeholder="0.00"
          required
        />
      </div>
      <div className="min-w-0">
        <label className={LABEL_CLASS}>{sellingLabel}</label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={sellingPrice}
          onChange={(event) => setSellingPrice(event.target.value)}
          className={`${FIELD_CLASS} text-right`}
          placeholder="0.00"
          required
        />
      </div>
    </>
  );
}
