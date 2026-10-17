import { ImageIcon, Upload, X } from "lucide-react";
import {
  LABEL_CLASS,
  FIELD_CLASS,
  INVENTORY_CATEGORIES,
  CAFE_UNITS,
} from "./inventoryStyles.js";
import {
  PURCHASE_UNITS,
  convertStockQtyForPackToggle,
  formatPackHint,
  hasPackConversion,
  purchaseQtyToBaseStock,
} from "../../utils/inventoryPack.js";
import { formatMoney, numMoney } from "../../utils/money.js";

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
          {subtitle ? (
            <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
          ) : null}
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
            title="Upload edited CSV to bulk update by Item ID"
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
              {imageStatus && imageStatus !== "No image selected" ? (
                <p className="mt-2 truncate text-xs text-slate-400">
                  {imageStatus}
                </p>
              ) : null}
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
  subCategory = "",
  setSubCategory,
  subCategorySuggestions = [],
  itemCode,
  setItemCode,
  itemName,
  setItemName,
  cost,
  setCost,
  sellingPrice,
  setSellingPrice,
  stockQty = "",
  setStockQty,
  baseUnit = "pcs",
  setBaseUnit,
  purchaseUnit = "",
  setPurchaseUnit,
  subQty = "",
  setSubQty,
  isEditing = false,
  directSale = false,
  setDirectSale,
  isActive = true,
  setIsActive,
  attentionLowQty = "",
  setAttentionLowQty,
  attentionUrgentQty = "",
  setAttentionUrgentQty,
  attentionVeryUrgentQty = "",
  setAttentionVeryUrgentQty,
  itemCodeLabel = "Item Code",
  itemCodePlaceholder = "Code",
  sellingLabel = "Selling Price",
}) {
  const packItem = {
    purchaseUnit,
    subQty,
    baseUnit: baseUnit || "pcs",
  };
  const packPreview = formatPackHint(packItem);
  const packActive = hasPackConversion(packItem);
  const enteredQty = numMoney(stockQty);
  const convertedStock = packActive
    ? purchaseQtyToBaseStock(enteredQty, packItem)
    : enteredQty;
  const suggestionId = "inventory-subcategory-suggestions";

  function changePurchaseUnit(nextUnit) {
    const next = String(nextUnit || "").trim();
    const wasActive = hasPackConversion(packItem);
    const nextActive = hasPackConversion({
      purchaseUnit: next,
      subQty,
    });
    if (setStockQty && stockQty !== "") {
      setStockQty(
        convertStockQtyForPackToggle({
          qty: stockQty,
          wasPackActive: wasActive,
          nextPackActive: nextActive,
          fromSubQty: subQty,
          toSubQty: subQty,
        })
      );
    }
    setPurchaseUnit?.(next);
    if (!next) setSubQty?.("");
  }

  function changeSubQty(nextSubQty) {
    const wasActive = hasPackConversion(packItem);
    const nextActive = hasPackConversion({
      purchaseUnit,
      subQty: nextSubQty,
    });
    if (setStockQty && stockQty !== "") {
      setStockQty(
        convertStockQtyForPackToggle({
          qty: stockQty,
          wasPackActive: wasActive,
          nextPackActive: nextActive,
          fromSubQty: subQty,
          toSubQty: nextSubQty,
        })
      );
    }
    setSubQty?.(nextSubQty);
  }

  return (
    <>
      <div className="md:col-span-2">
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-3">
          <input
            type="checkbox"
            checked={Boolean(directSale)}
            onChange={(event) => setDirectSale?.(event.target.checked)}
            className="h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500/40"
          />
          <span className="text-sm font-medium text-slate-100">Direct sale</span>
        </label>
        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2">
          <input
            type="checkbox"
            checked={isActive !== false}
            onChange={(event) => setIsActive?.(event.target.checked)}
            className="h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500/40"
          />
          <span className="text-sm font-medium text-slate-100">Active</span>
        </label>
      </div>
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
      <div className="min-w-0 md:col-span-2">
        <label className={LABEL_CLASS}>Sub category</label>
        <input
          value={subCategory}
          onChange={(event) => setSubCategory?.(event.target.value)}
          className={FIELD_CLASS}
          placeholder="Sub category"
          list={suggestionId}
          maxLength={60}
        />
        <datalist id={suggestionId}>
          {subCategorySuggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
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
      <div className="md:col-span-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-3">
        <div className="text-sm font-medium text-slate-100">Purchase pack</div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <label className={LABEL_CLASS}>Purchase unit</label>
            <select
              value={purchaseUnit || ""}
              onChange={(event) => changePurchaseUnit(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">None</option>
              {PURCHASE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label className={LABEL_CLASS}>Sub qty</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={subQty}
              onChange={(event) => changeSubQty(event.target.value)}
              className={`${FIELD_CLASS} text-right`}
              placeholder="0"
              disabled={!purchaseUnit}
            />
          </div>
          <div className="min-w-0">
            <label className={LABEL_CLASS}>Stock unit</label>
            <select
              value={baseUnit || "pcs"}
              onChange={(event) => setBaseUnit?.(event.target.value)}
              className={FIELD_CLASS}
            >
              {CAFE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </div>
        {packPreview ? (
          <p className="mt-2 text-xs font-medium text-sky-300">{packPreview}</p>
        ) : null}
      </div>

      <div className="min-w-0 md:col-span-2">
        <label className={LABEL_CLASS}>
          {isEditing ? "Current qty" : "Opening qty"}
          {packActive
            ? ` (${purchaseUnit})`
            : baseUnit
              ? ` (${baseUnit})`
              : ""}
        </label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={stockQty}
          onChange={(event) => setStockQty?.(event.target.value)}
          className={`${FIELD_CLASS} text-right`}
          placeholder="0"
        />
        {packActive && stockQty !== "" && Number.isFinite(enteredQty) ? (
          <p className="mt-1 text-xs font-medium text-sky-300">
            {formatMoney(enteredQty, 3)} {purchaseUnit} ={" "}
            {formatMoney(convertedStock, 3)} {baseUnit || "pcs"}
          </p>
        ) : null}
      </div>

      <div className="md:col-span-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-3">
        <div className="text-sm font-medium text-slate-100">
          Stock status thresholds
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <label className={LABEL_CLASS}>Low at qty</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={attentionLowQty}
              onChange={(event) => setAttentionLowQty?.(event.target.value)}
              className={`${FIELD_CLASS} text-right`}
              placeholder="0"
            />
          </div>
          <div className="min-w-0">
            <label className={LABEL_CLASS}>Urgent at qty</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={attentionUrgentQty}
              onChange={(event) => setAttentionUrgentQty?.(event.target.value)}
              className={`${FIELD_CLASS} text-right`}
              placeholder="0"
            />
          </div>
          <div className="min-w-0">
            <label className={LABEL_CLASS}>Very urgent at qty</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={attentionVeryUrgentQty}
              onChange={(event) =>
                setAttentionVeryUrgentQty?.(event.target.value)
              }
              className={`${FIELD_CLASS} text-right`}
              placeholder="0"
            />
          </div>
        </div>
      </div>
    </>
  );
}
