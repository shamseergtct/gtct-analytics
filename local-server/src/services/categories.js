import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

export function normalizeLabel(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mapCategory(row) {
  return {
    category_id: row.category_id,
    name: row.name,
    is_active: row.is_active,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapSubcategory(row) {
  return {
    subcategory_id: row.subcategory_id,
    category_id: row.category_id,
    name: row.name,
    is_active: row.is_active,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listCategories({ includeInactive = true } = {}) {
  const db = getDb();
  const categories = db
    .prepare(
      `SELECT * FROM menu_categories
       WHERE (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(includeInactive ? 1 : 0)
    .map(mapCategory);

  const subs = db
    .prepare(
      `SELECT * FROM menu_subcategories
       WHERE (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(includeInactive ? 1 : 0)
    .map(mapSubcategory);

  const catCounts = Object.fromEntries(
    db
      .prepare(
        `SELECT category_id AS id, COUNT(*) AS c
         FROM menu_items
         WHERE category_id IS NOT NULL
         GROUP BY category_id`
      )
      .all()
      .map((r) => [r.id, r.c])
  );
  const subCounts = Object.fromEntries(
    db
      .prepare(
        `SELECT subcategory_id AS id, COUNT(*) AS c
         FROM menu_items
         WHERE subcategory_id IS NOT NULL
         GROUP BY subcategory_id`
      )
      .all()
      .map((r) => [r.id, r.c])
  );

  for (const cat of categories) {
    cat.itemCount = catCounts[cat.category_id] || 0;
    cat.subcategoryCount = subs.filter(
      (s) => s.category_id === cat.category_id
    ).length;
  }
  for (const sub of subs) {
    sub.itemCount = subCounts[sub.subcategory_id] || 0;
  }

  const subcategoriesByCategory = {};
  for (const sub of subs) {
    if (!subcategoriesByCategory[sub.category_id]) {
      subcategoriesByCategory[sub.category_id] = [];
    }
    subcategoriesByCategory[sub.category_id].push(sub);
  }

  return {
    categories,
    subcategories: subs,
    subcategoriesByCategory,
    // Back-compat for Sales category chips
    categoryNames: categories.map((c) => c.name),
  };
}

export function getCategory(categoryId) {
  const row = getDb()
    .prepare(`SELECT * FROM menu_categories WHERE category_id = ?`)
    .get(categoryId);
  return row ? mapCategory(row) : null;
}

export function getSubcategory(subcategoryId) {
  const row = getDb()
    .prepare(`SELECT * FROM menu_subcategories WHERE subcategory_id = ?`)
    .get(subcategoryId);
  return row ? mapSubcategory(row) : null;
}

export function upsertCategory(input = {}) {
  const db = getDb();
  const name = String(input.name || "").trim();
  if (!name) {
    throw Object.assign(new Error("Category name is required"), { status: 400 });
  }
  const norm = normalizeLabel(name);
  const categoryId = String(input.categoryId || input.category_id || newId("cat"));
  const existing = db
    .prepare(`SELECT * FROM menu_categories WHERE category_id = ?`)
    .get(categoryId);
  const clash = db
    .prepare(
      `SELECT category_id FROM menu_categories WHERE name_normalized = ?`
    )
    .get(norm);
  if (clash && clash.category_id !== categoryId) {
    throw Object.assign(new Error(`Category already exists: ${name}`), {
      status: 409,
    });
  }

  const ts = nowIso();
  const isActive =
    input.isActive != null
      ? input.isActive !== false && input.isActive !== 0
      : existing
        ? Boolean(existing.is_active)
        : true;
  const sortOrder =
    input.sortOrder != null
      ? Number(input.sortOrder)
      : existing
        ? Number(existing.sort_order || 0)
        : 0;

  if (existing) {
    // Soft-deactivate only — do not delete when referenced.
    db.prepare(
      `UPDATE menu_categories
       SET name = ?, name_normalized = ?, is_active = ?, sort_order = ?, updated_at = ?
       WHERE category_id = ?`
    ).run(name, norm, isActive ? 1 : 0, sortOrder, ts, categoryId);
    // Keep denormalized item text in sync for active renames
    db.prepare(
      `UPDATE menu_items SET category = ?, updated_at = ? WHERE category_id = ?`
    ).run(name, ts, categoryId);
  } else {
    db.prepare(
      `INSERT INTO menu_categories (
         category_id, name, name_normalized, is_active, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(categoryId, name, norm, isActive ? 1 : 0, sortOrder, ts, ts);
  }
  return getCategory(categoryId);
}

export function upsertSubcategory(input = {}) {
  const db = getDb();
  const name = String(input.name || "").trim();
  const categoryId = String(input.categoryId || input.category_id || "").trim();
  if (!name) {
    throw Object.assign(new Error("Subcategory name is required"), {
      status: 400,
    });
  }
  if (!categoryId || !getCategory(categoryId)) {
    throw Object.assign(new Error("Valid parent category is required"), {
      status: 400,
    });
  }
  const norm = normalizeLabel(name);
  const subcategoryId = String(
    input.subcategoryId || input.subcategory_id || newId("sub")
  );
  const existing = db
    .prepare(`SELECT * FROM menu_subcategories WHERE subcategory_id = ?`)
    .get(subcategoryId);
  const clash = db
    .prepare(
      `SELECT subcategory_id FROM menu_subcategories
       WHERE category_id = ? AND name_normalized = ?`
    )
    .get(categoryId, norm);
  if (clash && clash.subcategory_id !== subcategoryId) {
    throw Object.assign(
      new Error(`Subcategory already exists under this category: ${name}`),
      { status: 409 }
    );
  }

  const ts = nowIso();
  const isActive =
    input.isActive != null
      ? input.isActive !== false && input.isActive !== 0
      : existing
        ? Boolean(existing.is_active)
        : true;
  const sortOrder =
    input.sortOrder != null
      ? Number(input.sortOrder)
      : existing
        ? Number(existing.sort_order || 0)
        : 0;

  if (existing) {
    if (existing.category_id !== categoryId) {
      throw Object.assign(
        new Error("Cannot move subcategory to a different parent in this phase"),
        { status: 400 }
      );
    }
    db.prepare(
      `UPDATE menu_subcategories
       SET name = ?, name_normalized = ?, is_active = ?, sort_order = ?, updated_at = ?
       WHERE subcategory_id = ?`
    ).run(name, norm, isActive ? 1 : 0, sortOrder, ts, subcategoryId);
    db.prepare(
      `UPDATE menu_items SET subcategory = ?, updated_at = ? WHERE subcategory_id = ?`
    ).run(name, ts, subcategoryId);
  } else {
    db.prepare(
      `INSERT INTO menu_subcategories (
         subcategory_id, category_id, name, name_normalized,
         is_active, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      subcategoryId,
      categoryId,
      name,
      norm,
      isActive ? 1 : 0,
      sortOrder,
      ts,
      ts
    );
  }
  return getSubcategory(subcategoryId);
}

/**
 * Resolve category/subcategory ids from form input (ids and/or names).
 * Creates missing names when createIfMissing is true (admin item form quick-create).
 */
export function resolveCategoryAssignment(
  {
    categoryId = null,
    subcategoryId = null,
    categoryName = null,
    subcategoryName = null,
  } = {},
  { createIfMissing = false } = {}
) {
  const db = getDb();
  let resolvedCategoryId = categoryId ? String(categoryId) : null;
  let resolvedSubcategoryId = subcategoryId ? String(subcategoryId) : null;
  let category = "";
  let subcategory = "";

  if (resolvedCategoryId) {
    const cat = getCategory(resolvedCategoryId);
    if (!cat) {
      throw Object.assign(new Error("Unknown categoryId"), { status: 400 });
    }
    category = cat.name;
  } else if (categoryName != null && String(categoryName).trim()) {
    const name = String(categoryName).trim();
    const norm = normalizeLabel(name);
    const existing = db
      .prepare(
        `SELECT category_id, name FROM menu_categories WHERE name_normalized = ?`
      )
      .get(norm);
    if (existing) {
      resolvedCategoryId = existing.category_id;
      category = existing.name;
    } else if (createIfMissing) {
      const created = upsertCategory({ name });
      resolvedCategoryId = created.category_id;
      category = created.name;
    } else {
      throw Object.assign(new Error(`Unknown category: ${name}`), { status: 400 });
    }
  }

  if (resolvedSubcategoryId) {
    const sub = getSubcategory(resolvedSubcategoryId);
    if (!sub) {
      throw Object.assign(new Error("Unknown subcategoryId"), { status: 400 });
    }
    if (resolvedCategoryId && sub.category_id !== resolvedCategoryId) {
      throw Object.assign(
        new Error("Subcategory does not belong to the selected category"),
        { status: 400 }
      );
    }
    resolvedCategoryId = resolvedCategoryId || sub.category_id;
    const parent = getCategory(resolvedCategoryId);
    category = parent?.name || category;
    subcategory = sub.name;
  } else if (
    resolvedCategoryId &&
    subcategoryName != null &&
    String(subcategoryName).trim()
  ) {
    const name = String(subcategoryName).trim();
    const norm = normalizeLabel(name);
    const existing = db
      .prepare(
        `SELECT subcategory_id, name FROM menu_subcategories
         WHERE category_id = ? AND name_normalized = ?`
      )
      .get(resolvedCategoryId, norm);
    if (existing) {
      resolvedSubcategoryId = existing.subcategory_id;
      subcategory = existing.name;
    } else if (createIfMissing) {
      const created = upsertSubcategory({
        categoryId: resolvedCategoryId,
        name,
      });
      resolvedSubcategoryId = created.subcategory_id;
      subcategory = created.name;
    } else {
      throw Object.assign(new Error(`Unknown subcategory: ${name}`), {
        status: 400,
      });
    }
  }

  // Subcategory without category is invalid
  if (!resolvedCategoryId && resolvedSubcategoryId) {
    throw Object.assign(new Error("Subcategory requires a parent category"), {
      status: 400,
    });
  }

  return {
    categoryId: resolvedCategoryId,
    subcategoryId: resolvedSubcategoryId,
    category,
    subcategory,
  };
}

function applyOrder(table, idColumn, ids, scopeSql = "", scopeArgs = []) {
  const db = getDb();
  const list = Array.isArray(ids) ? ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!list.length || new Set(list).size !== list.length) {
    throw Object.assign(new Error("Send each id once, in the new order."), { status: 400 });
  }
  const existing = db
    .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE 1 = 1 ${scopeSql}`)
    .all(...scopeArgs)
    .map((r) => r.id);
  if (list.length !== existing.length || list.some((id) => !existing.includes(id))) {
    throw Object.assign(new Error("The list changed. Refresh the page and try again."), {
      status: 409,
    });
  }
  const ts = nowIso();
  const update = db.prepare(
    `UPDATE ${table} SET sort_order = ?, updated_at = ? WHERE ${idColumn} = ?`
  );
  db.transaction(() => {
    list.forEach((id, index) => update.run((index + 1) * 10, ts, id));
  })();
}

/** Save the display order of all categories (active and inactive). */
export function reorderCategories(categoryIds) {
  applyOrder("menu_categories", "category_id", categoryIds);
  return listCategories({ includeInactive: true });
}

/** Save the display order of the subcategories of one category. */
export function reorderSubcategories(categoryId, subcategoryIds) {
  const id = String(categoryId || "").trim();
  if (!id || !getCategory(id)) {
    throw Object.assign(new Error("Valid parent category is required"), { status: 400 });
  }
  applyOrder("menu_subcategories", "subcategory_id", subcategoryIds, "AND category_id = ?", [id]);
  return listCategories({ includeInactive: true });
}
