import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
} from "firebase/storage";
import { ArrowDown, ArrowUp, ImageIcon, Plus, Save, Upload, X } from "lucide-react";
import { Link } from "react-router-dom";
import { db, storage } from "../firebase";
import { useAuth } from "../context/AuthContext.jsx";
import { useClient } from "../context/ClientContext.jsx";
import { useMoney } from "../hooks/useMoney.js";
import {
  isDirectSaleItem,
  isInventoryItemActive,
  num,
} from "../components/sales/salesHelpers.js";
import { normalizeShopType, shopTypeLabel } from "../utils/shopTypes.js";
import {
  assignMenuSortOrders,
  compareMenuItems,
} from "../utils/restaurantMenu.js";

const RESTAURANT_SHOP_TYPES = new Set(["cafe", "restaurant"]);
const CATEGORIES = ["COMMODITY", "CONSUMABLES", "ASSET"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function safeImageName(name) {
  return String(name || "item-image")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(-100);
}

const emptyForm = () => ({
  itemName: "",
  itemCode: "",
  sellingPrice: "",
  cost: "0",
  category: "COMMODITY",
  subCategory: "",
  directSale: true,
  isActive: true,
  imageUrl: "",
  imagePath: "",
  imageName: "",
  imageStatus: "NONE",
});

export default function RestaurantMenuSetup() {
  const { user, canManageShopOps } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { money } = useMoney();

  const shopType = normalizeShopType(activeClientData?.shop_type);
  const shopOk = RESTAURANT_SHOP_TYPES.has(shopType);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(true);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState("");
  const [imageStatus, setImageStatus] = useState("No image selected");

  useEffect(() => {
    if (!activeClientId || !shopOk) {
      setItems([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", activeClientId),
      orderBy("itemName", "asc")
    );
    return onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (error) => {
        setErr(error?.message || "Could not load menu items.");
        setItems([]);
        setLoading(false);
      }
    );
  }, [activeClientId, shopOk]);

  const menuRows = useMemo(() => {
    return items
      .filter((it) => {
        if (!isDirectSaleItem(it) && !showInactive) return false;
        // Setup shows all direct-sale items; optionally include inactive
        if (!isDirectSaleItem(it)) return false;
        if (!showInactive && !isInventoryItemActive(it)) return false;
        return true;
      })
      .slice()
      .sort(compareMenuItems);
  }, [items, showInactive]);

  function patchForm(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function clearImagePicker() {
    if (imagePreview && imagePreview.startsWith("blob:")) {
      URL.revokeObjectURL(imagePreview);
    }
    setImageFile(null);
    setImagePreview("");
    setImageStatus("No image selected");
  }

  function handleImageChange(event) {
    const file = event.target.files?.[0] || null;
    if (!file) {
      clearImagePicker();
      return;
    }
    if (!file.type.startsWith("image/")) {
      event.target.value = "";
      setErr("Please select an image file.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      event.target.value = "";
      setErr("Item image must be 5 MB or smaller.");
      return;
    }
    if (imagePreview && imagePreview.startsWith("blob:")) {
      URL.revokeObjectURL(imagePreview);
    }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setImageStatus(`${file.name} ready to upload`);
    setErr("");
  }

  function startAdd() {
    setAdding(true);
    setEditingId("");
    setForm(emptyForm());
    clearImagePicker();
    setErr("");
    setMsg("");
  }

  function startEdit(item) {
    setAdding(false);
    setEditingId(item.id);
    setForm({
      itemName: item.itemName || "",
      itemCode: item.itemCode || "",
      sellingPrice: String(item.sellingPrice ?? ""),
      cost: String(item.cost ?? "0"),
      category: item.category || "COMMODITY",
      subCategory: item.subCategory || "",
      directSale: item.directSale !== false,
      isActive: item.isActive !== false,
      imageUrl: item.imageUrl || "",
      imagePath: item.imagePath || "",
      imageName: item.imageName || "",
      imageStatus: item.imageStatus || (item.imageUrl ? "UPLOADED" : "NONE"),
    });
    if (imagePreview && imagePreview.startsWith("blob:")) {
      URL.revokeObjectURL(imagePreview);
    }
    setImageFile(null);
    setImagePreview(item.imageUrl || "");
    setImageStatus(
      item.imageUrl ? item.imageName || "Current image" : "No image selected"
    );
    setErr("");
    setMsg("");
  }

  function cancelEdit() {
    setAdding(false);
    setEditingId("");
    setForm(emptyForm());
    clearImagePicker();
  }

  function describeStorageError(reason) {
    const code = String(reason?.code || "");
    const message = String(reason?.message || "").trim();
    if (code === "storage/unauthorized" || code === "storage/unauthenticated") {
      return "Not allowed to upload images for this shop. Sign in again or ask an admin to check Storage rules.";
    }
    if (code === "storage/canceled") {
      return "Image upload was canceled.";
    }
    if (code === "storage/retry-limit-exceeded") {
      return "Network issue while uploading. Check connection and try a smaller image.";
    }
    if (code === "storage/quota-exceeded") {
      return "Storage quota exceeded.";
    }
    return message || "Image upload failed. Try a smaller JPG/PNG (max 5 MB).";
  }

  function uploadMenuImageFile(itemId) {
    const previous = {
      imageUrl: form.imageUrl || "",
      imagePath: form.imagePath || "",
      imageName: form.imageName || "",
      imageStatus:
        form.imageStatus || (form.imageUrl ? "UPLOADED" : "NONE"),
    };
    if (!imageFile || !activeClientId || !itemId) {
      return Promise.resolve({ ok: true, ...previous });
    }

    const contentType = String(imageFile.type || "").trim() || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return Promise.resolve({
        ok: false,
        message: "Selected file is not a valid image.",
        ...previous,
      });
    }

    setImageStatus("Uploading image…");
    const uploadedPath = `inventory/${activeClientId}/${itemId}/${Date.now()}-${safeImageName(
      imageFile.name
    )}`;
    const fileRef = storageRef(storage, uploadedPath);
    const task = uploadBytesResumable(fileRef, imageFile, { contentType });

    return new Promise((resolve) => {
      task.on(
        "state_changed",
        (snapshot) => {
          if (!snapshot.totalBytes) return;
          const pct = Math.round(
            (snapshot.bytesTransferred / snapshot.totalBytes) * 100
          );
          setImageStatus(`Uploading image… ${pct}%`);
        },
        (reason) => {
          resolve({
            ok: false,
            message: describeStorageError(reason),
            ...previous,
          });
        },
        async () => {
          try {
            const imageUrl = await getDownloadURL(task.snapshot.ref);
            resolve({
              ok: true,
              imageUrl,
              imagePath: uploadedPath,
              imageName: imageFile.name,
              imageStatus: "UPLOADED",
            });
          } catch (reason) {
            resolve({
              ok: false,
              message: describeStorageError(reason),
              ...previous,
            });
          }
        }
      );
    });
  }

  async function saveForm(event) {
    event?.preventDefault?.();
    if (!canManageShopOps || !activeClientId) return;
    if (saving) return;

    const cleanName = String(form.itemName || "").trim();
    const cleanCode = String(form.itemCode || "").trim();
    const sellingValue = Math.max(0, num(form.sellingPrice));
    const costValue = Math.max(0, num(form.cost));
    if (!cleanName) {
      setErr("Item name is required.");
      return;
    }
    if (!cleanCode) {
      setErr("Item code is required.");
      return;
    }

    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const itemRef = adding
        ? doc(collection(db, "inventory"))
        : doc(db, "inventory", editingId);

      // Save item fields first so image problems never block the record.
      const menuFields = {
        category: form.category || "COMMODITY",
        subCategory: String(form.subCategory || "").trim(),
        itemCode: cleanCode,
        itemName: cleanName,
        cost: costValue,
        sellingPrice: sellingValue,
        directSale: form.directSale !== false,
        isActive: form.isActive !== false,
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null,
      };

      if (adding) {
        const maxOrder = menuRows.reduce((max, row) => {
          const o = Number(row.menuSortOrder);
          return Number.isFinite(o) ? Math.max(max, o) : max;
        }, -1);
        await setDoc(itemRef, {
          clientId: activeClientId,
          ...menuFields,
          imageUrl: form.imageUrl || "",
          imagePath: form.imagePath || "",
          imageName: form.imageName || "",
          imageStatus: form.imageUrl ? "UPLOADED" : "NONE",
          barcode: "",
          minStock: 0,
          batchNo: "",
          expiryDate: "",
          baseUnit: "pcs",
          purchaseUnit: "",
          subQty: 0,
          recipeNotes: "",
          unitsPerCarton: 12,
          wholesalePrice: 0,
          menuSortOrder: maxOrder + 1,
          currentStock: 0,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
          createdBy: user?.uid || null,
        });
      } else if (editingId) {
        await updateDoc(itemRef, menuFields);
      }

      let imageNote = "";
      if (imageFile) {
        const imageResult = await uploadMenuImageFile(itemRef.id);
        if (imageResult.ok) {
          await updateDoc(itemRef, {
            imageUrl: imageResult.imageUrl,
            imagePath: imageResult.imagePath,
            imageName: imageResult.imageName,
            imageStatus: "UPLOADED",
            updatedAt: serverTimestamp(),
            updatedBy: user?.uid || null,
          });
          setImageStatus("Image uploaded");
        } else {
          setImageStatus("Upload failed — item saved without new image");
          imageNote = imageResult.message;
          window.alert(
            `Item saved, but the image could not be uploaded.\n\n${imageResult.message}`
          );
        }
      }

      setMsg(
        imageNote
          ? adding
            ? "Menu item added. Image was not uploaded."
            : "Menu item updated. Image was not uploaded."
          : adding
            ? "Menu item added."
            : "Menu item updated."
      );
      cancelEdit();
    } catch (reason) {
      setErr(reason?.message || "Could not save menu item.");
      if (imageFile) setImageStatus("Upload failed");
    } finally {
      setSaving(false);
    }
  }

  async function persistOrder(ordered) {
    const assignments = assignMenuSortOrders(ordered);
    const batch = writeBatch(db);
    for (const row of assignments) {
      batch.update(doc(db, "inventory", row.id), {
        menuSortOrder: row.menuSortOrder,
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null,
      });
    }
    await batch.commit();
  }

  async function moveRow(itemId, direction) {
    if (!canManageShopOps) return;
    const index = menuRows.findIndex((row) => row.id === itemId);
    if (index < 0) return;
    const next = index + direction;
    if (next < 0 || next >= menuRows.length) return;

    const ordered = menuRows.slice();
    const [row] = ordered.splice(index, 1);
    ordered.splice(next, 0, row);

    setSaving(true);
    setErr("");
    setMsg("");
    try {
      await persistOrder(ordered);
      setMsg("Menu order updated.");
    } catch (reason) {
      setErr(reason?.message || "Could not reorder menu.");
    } finally {
      setSaving(false);
    }
  }

  if (!canManageShopOps) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-slate-300">
        Menu setup is available to shop managers only.
      </div>
    );
  }

  if (!activeClientId) {
    return (
      <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-6 text-amber-100">
        Select an active shop to manage the restaurant menu.
      </div>
    );
  }

  if (!shopOk) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-xl font-semibold text-white">Menu Setup</h1>
        <p className="mt-2 text-sm text-slate-400">
          Menu setup is for {shopTypeLabel("cafe")} and{" "}
          {shopTypeLabel("restaurant")} shops only.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white sm:text-2xl">
            Menu Setup
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {shopTypeLabel(shopType)} · Arrange, add, and edit POS menu items
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/restaurant-sales"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"
          >
            Back to sales
          </Link>
          <Link
            to="/inventory"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"
          >
            Full inventory
          </Link>
          <button
            type="button"
            onClick={startAdd}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950"
          >
            <Plus size={16} />
            Add item
          </button>
        </div>
      </div>

      {err ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {err}
        </div>
      ) : null}
      {msg ? (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {msg}
        </div>
      ) : null}

      <label className="inline-flex items-center gap-2 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          className="rounded border-slate-600"
        />
        Show inactive items
      </label>

      {(adding || editingId) && (
        <form
          onSubmit={saveForm}
          className="space-y-3 rounded-2xl border border-slate-700 bg-slate-900/50 p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">
              {adding ? "Add menu item" : "Edit menu item"}
            </h2>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-lg border border-slate-700 p-1.5 text-slate-400"
              aria-label="Close form"
            >
              <X size={16} />
            </button>
          </div>
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/50 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Item image
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
                {imagePreview ? (
                  <img
                    src={imagePreview}
                    alt="Menu item preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImageIcon size={28} className="text-slate-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">
                  <Upload size={16} />
                  Choose image
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageChange}
                    className="sr-only"
                  />
                </label>
                <p className="mt-1.5 truncate text-xs text-slate-500">
                  {imageStatus}
                </p>
                <p className="text-[11px] text-slate-600">
                  JPG, PNG, or WebP · max 5 MB
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-slate-300 sm:col-span-2">
              Name
              <input
                required
                value={form.itemName}
                onChange={(e) => patchForm("itemName", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Code
              <input
                required
                value={form.itemCode}
                onChange={(e) => patchForm("itemCode", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Selling price
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={form.sellingPrice}
                onChange={(e) => patchForm("sellingPrice", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Category
              <select
                value={form.category}
                onChange={(e) => patchForm("category", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-slate-300">
              Sub-category / section
              <input
                value={form.subCategory}
                onChange={(e) => patchForm("subCategory", e.target.value)}
                placeholder="e.g. Burgers, Drinks"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={form.directSale}
                onChange={(e) => patchForm("directSale", e.target.checked)}
              />
              On POS menu (direct sale)
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => patchForm("isActive", e.target.checked)}
              />
              Active
            </label>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-[#0B539E] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Save size={16} />
            {saving ? "Saving…" : "Save item"}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-800">
        {loading ? (
          <p className="p-4 text-sm text-slate-400">Loading menu…</p>
        ) : menuRows.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            No menu items yet. Add an item or mark inventory as Direct sale.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {menuRows.map((item, index) => {
              const inactive = !isInventoryItemActive(item);
              return (
                <li
                  key={item.id}
                  className={`flex items-center gap-2 px-3 py-3 ${
                    inactive ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      disabled={saving || index === 0}
                      onClick={() => moveRow(item.id, -1)}
                      className="rounded border border-slate-700 p-1.5 text-slate-300 disabled:opacity-30"
                      aria-label={`Move ${item.itemName} up`}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={saving || index === menuRows.length - 1}
                      onClick={() => moveRow(item.id, 1)}
                      className="rounded border border-slate-700 p-1.5 text-slate-300 disabled:opacity-30"
                      aria-label={`Move ${item.itemName} down`}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </div>
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageIcon size={18} className="text-slate-600" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white">
                      {item.itemName}
                      {inactive ? (
                        <span className="ml-2 text-xs font-normal text-rose-300">
                          Inactive
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-slate-500">
                      {item.itemCode || "—"}
                      {item.subCategory ? ` · ${item.subCategory}` : ""}
                      {" · "}
                      {money(item.sellingPrice)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => startEdit(item)}
                    className="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200"
                  >
                    Edit
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
