import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";

const LIMITS = {
  detailedDescription: 2000,
  brand: 120,
  ingredientBrand: 200,
  servingStyle: 200,
  servingAccompaniments: 400,
  serviceNotes: 400,
  specialFeatures: 1000,
  allergenNotes: 1000,
  salesmanQuickAnswer: 500,
  staffTrainingNotes: 2000,
  ingredientName: 80,
  maxIngredients: 40,
};

function clampText(value, max) {
  const s = String(value ?? "").trim();
  if (s.length > max) {
    throw Object.assign(
      new Error(`Text exceeds maximum length of ${max} characters`),
      { status: 400 }
    );
  }
  return s;
}

function parseIngredientsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => String(v ?? "").trim())
      .filter(Boolean)
      .slice(0, LIMITS.maxIngredients);
  } catch {
    return [];
  }
}

function normalizeIngredients(input) {
  if (input == null) return [];
  let list = input;
  if (typeof input === "string") {
    list = input
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(list)) {
    throw Object.assign(new Error("ingredients must be an array of strings"), {
      status: 400,
    });
  }
  const cleaned = [];
  const seen = new Set();
  for (const raw of list) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    if (name.length > LIMITS.ingredientName) {
      throw Object.assign(
        new Error(
          `Ingredient name exceeds ${LIMITS.ingredientName} characters`
        ),
        { status: 400 }
      );
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(name);
    if (cleaned.length > LIMITS.maxIngredients) {
      throw Object.assign(
        new Error(`At most ${LIMITS.maxIngredients} ingredients allowed`),
        { status: 400 }
      );
    }
  }
  return cleaned;
}

function parseOptionalMinutes(value, field) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 999) {
    throw Object.assign(
      new Error(`${field} must be an integer from 0 to 999`),
      { status: 400 }
    );
  }
  return n;
}

function emptyProfile(itemId) {
  return {
    itemId,
    detailedDescription: "",
    ingredients: [],
    brand: "",
    ingredientBrand: "",
    prepTimeMin: null,
    prepTimeMax: null,
    servingStyle: "",
    servingAccompaniments: "",
    serviceNotes: "",
    specialFeatures: "",
    allergenNotes: "",
    allergenVerified: false,
    salesmanQuickAnswer: "",
    staffTrainingNotes: "",
    hasContent: false,
    createdAt: null,
    updatedAt: null,
  };
}

function mapRow(row, { includeStaffNotes = false } = {}) {
  if (!row) return null;
  const ingredients = parseIngredientsJson(row.ingredients_json);
  const profile = {
    itemId: row.item_id,
    detailedDescription: row.detailed_description || "",
    ingredients,
    brand: row.brand || "",
    ingredientBrand: row.ingredient_brand || "",
    prepTimeMin:
      row.prep_time_min == null ? null : Number(row.prep_time_min),
    prepTimeMax:
      row.prep_time_max == null ? null : Number(row.prep_time_max),
    servingStyle: row.serving_style || "",
    servingAccompaniments: row.serving_accompaniments || "",
    serviceNotes: row.service_notes || "",
    specialFeatures: row.special_features || "",
    allergenNotes: row.allergen_notes || "",
    allergenVerified: Boolean(Number(row.allergen_verified || 0)),
    salesmanQuickAnswer: row.salesman_quick_answer || "",
    hasContent: profileHasContent(row, ingredients),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
  if (includeStaffNotes) {
    profile.staffTrainingNotes = row.staff_training_notes || "";
  }
  return profile;
}

function profileHasContent(row, ingredients) {
  if (!row) return false;
  if (ingredients?.length) return true;
  if (String(row.detailed_description || "").trim()) return true;
  if (String(row.brand || "").trim()) return true;
  if (String(row.ingredient_brand || "").trim()) return true;
  if (row.prep_time_min != null || row.prep_time_max != null) return true;
  if (String(row.serving_style || "").trim()) return true;
  if (String(row.serving_accompaniments || "").trim()) return true;
  if (String(row.service_notes || "").trim()) return true;
  if (String(row.special_features || "").trim()) return true;
  if (String(row.allergen_notes || "").trim()) return true;
  if (String(row.salesman_quick_answer || "").trim()) return true;
  if (String(row.staff_training_notes || "").trim()) return true;
  return false;
}

/** Public emptiness check including short description from menu item. */
export function knowledgeHasDisplayContent(profile, shortDescription = "") {
  if (String(shortDescription || "").trim()) return true;
  if (!profile) return false;
  return Boolean(profile.hasContent);
}

export function getProductKnowledge(itemId, { role = "device" } = {}) {
  const db = getDb();
  const id = String(itemId || "");
  const item = db
    .prepare(`SELECT item_id FROM menu_items WHERE item_id = ?`)
    .get(id);
  if (!item) return null;
  const row = db
    .prepare(`SELECT * FROM menu_item_product_knowledge WHERE item_id = ?`)
    .get(id);
  const includeStaffNotes = role === "admin";
  if (!row) {
    const empty = emptyProfile(id);
    if (!includeStaffNotes) delete empty.staffTrainingNotes;
    return empty;
  }
  return mapRow(row, { includeStaffNotes });
}

export function upsertProductKnowledge(itemId, input = {}, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin only"), { status: 403 });
  }
  const db = getDb();
  const id = String(itemId || "");
  const item = db
    .prepare(`SELECT item_id FROM menu_items WHERE item_id = ?`)
    .get(id);
  if (!item) {
    throw Object.assign(new Error("Menu item not found"), { status: 404 });
  }

  const existing = db
    .prepare(`SELECT * FROM menu_item_product_knowledge WHERE item_id = ?`)
    .get(id);

  const detailedDescription =
    input.detailedDescription != null || input.detailed_description != null
      ? clampText(
          input.detailedDescription ?? input.detailed_description,
          LIMITS.detailedDescription
        )
      : existing?.detailed_description || "";

  const ingredients =
    input.ingredients != null
      ? normalizeIngredients(input.ingredients)
      : parseIngredientsJson(existing?.ingredients_json);

  const brand =
    input.brand != null
      ? clampText(input.brand, LIMITS.brand)
      : existing?.brand || "";

  const ingredientBrand =
    input.ingredientBrand != null || input.ingredient_brand != null
      ? clampText(
          input.ingredientBrand ?? input.ingredient_brand,
          LIMITS.ingredientBrand
        )
      : existing?.ingredient_brand || "";

  let prepTimeMin =
    Object.prototype.hasOwnProperty.call(input, "prepTimeMin") ||
    Object.prototype.hasOwnProperty.call(input, "prep_time_min")
      ? parseOptionalMinutes(
          input.prepTimeMin ?? input.prep_time_min,
          "prepTimeMin"
        )
      : existing?.prep_time_min == null
        ? null
        : Number(existing.prep_time_min);

  let prepTimeMax =
    Object.prototype.hasOwnProperty.call(input, "prepTimeMax") ||
    Object.prototype.hasOwnProperty.call(input, "prep_time_max")
      ? parseOptionalMinutes(
          input.prepTimeMax ?? input.prep_time_max,
          "prepTimeMax"
        )
      : existing?.prep_time_max == null
        ? null
        : Number(existing.prep_time_max);

  if (
    prepTimeMin != null &&
    prepTimeMax != null &&
    prepTimeMax < prepTimeMin
  ) {
    throw Object.assign(
      new Error("prepTimeMax must be greater than or equal to prepTimeMin"),
      { status: 400 }
    );
  }

  const servingStyle =
    input.servingStyle != null || input.serving_style != null
      ? clampText(
          input.servingStyle ?? input.serving_style,
          LIMITS.servingStyle
        )
      : existing?.serving_style || "";

  const servingAccompaniments =
    input.servingAccompaniments != null ||
    input.serving_accompaniments != null
      ? clampText(
          input.servingAccompaniments ?? input.serving_accompaniments,
          LIMITS.servingAccompaniments
        )
      : existing?.serving_accompaniments || "";

  const serviceNotes =
    input.serviceNotes != null || input.service_notes != null
      ? clampText(
          input.serviceNotes ?? input.service_notes,
          LIMITS.serviceNotes
        )
      : existing?.service_notes || "";

  const specialFeatures =
    input.specialFeatures != null || input.special_features != null
      ? clampText(
          input.specialFeatures ?? input.special_features,
          LIMITS.specialFeatures
        )
      : existing?.special_features || "";

  const allergenNotes =
    input.allergenNotes != null || input.allergen_notes != null
      ? clampText(
          input.allergenNotes ?? input.allergen_notes,
          LIMITS.allergenNotes
        )
      : existing?.allergen_notes || "";

  const allergenVerified =
    input.allergenVerified != null || input.allergen_verified != null
      ? Boolean(input.allergenVerified ?? input.allergen_verified)
      : Boolean(Number(existing?.allergen_verified || 0));

  const salesmanQuickAnswer =
    input.salesmanQuickAnswer != null ||
    input.salesman_quick_answer != null
      ? clampText(
          input.salesmanQuickAnswer ?? input.salesman_quick_answer,
          LIMITS.salesmanQuickAnswer
        )
      : existing?.salesman_quick_answer || "";

  const staffTrainingNotes =
    input.staffTrainingNotes != null || input.staff_training_notes != null
      ? clampText(
          input.staffTrainingNotes ?? input.staff_training_notes,
          LIMITS.staffTrainingNotes
        )
      : existing?.staff_training_notes || "";

  const ts = nowIso();
  const ingredientsJson = JSON.stringify(ingredients);

  if (existing) {
    db.prepare(
      `UPDATE menu_item_product_knowledge SET
         detailed_description = ?,
         ingredients_json = ?,
         brand = ?,
         ingredient_brand = ?,
         prep_time_min = ?,
         prep_time_max = ?,
         serving_style = ?,
         serving_accompaniments = ?,
         service_notes = ?,
         special_features = ?,
         allergen_notes = ?,
         allergen_verified = ?,
         salesman_quick_answer = ?,
         staff_training_notes = ?,
         updated_at = ?
       WHERE item_id = ?`
    ).run(
      detailedDescription,
      ingredientsJson,
      brand,
      ingredientBrand,
      prepTimeMin,
      prepTimeMax,
      servingStyle,
      servingAccompaniments,
      serviceNotes,
      specialFeatures,
      allergenNotes,
      allergenVerified ? 1 : 0,
      salesmanQuickAnswer,
      staffTrainingNotes,
      ts,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO menu_item_product_knowledge (
         item_id, detailed_description, ingredients_json,
         brand, ingredient_brand, prep_time_min, prep_time_max,
         serving_style, serving_accompaniments, service_notes, special_features,
         allergen_notes, allergen_verified, salesman_quick_answer,
         staff_training_notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      detailedDescription,
      ingredientsJson,
      brand,
      ingredientBrand,
      prepTimeMin,
      prepTimeMax,
      servingStyle,
      servingAccompaniments,
      serviceNotes,
      specialFeatures,
      allergenNotes,
      allergenVerified ? 1 : 0,
      salesmanQuickAnswer,
      staffTrainingNotes,
      ts,
      ts
    );
  }

  return getProductKnowledge(id, { role: "admin" });
}

export function formatPrepTimeLabel(prepTimeMin, prepTimeMax) {
  if (prepTimeMin == null && prepTimeMax == null) return null;
  if (prepTimeMin != null && prepTimeMax != null) {
    if (prepTimeMin === prepTimeMax) {
      return `${prepTimeMin} minute${prepTimeMin === 1 ? "" : "s"}`;
    }
    return `${prepTimeMin}–${prepTimeMax} minutes`;
  }
  const n = prepTimeMin ?? prepTimeMax;
  return `About ${n} minute${n === 1 ? "" : "s"}`;
}

export { LIMITS as PRODUCT_KNOWLEDGE_LIMITS };
