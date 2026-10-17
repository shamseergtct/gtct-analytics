/**
 * Configurable kitchen instruction types/targets for Restaurant Sales.
 * Shop-admin Firestore config can replace this module later without UI rewrites.
 */

export const KITCHEN_INSTRUCTION_TYPES = [
  {
    id: "less",
    label: "Less",
    /** `{target}` = lowercased target label; `{Target}` = original casing */
    template: "Less {target}",
  },
  {
    id: "more",
    label: "More",
    template: "More {target}",
  },
  {
    id: "no",
    label: "No",
    template: "No {target}",
  },
  {
    id: "extra",
    label: "Extra",
    template: "Extra {target}",
  },
  {
    id: "separate",
    label: "Separate",
    template: "{Target} on the side",
  },
  {
    id: "other",
    label: "Other",
    template: null,
    requiresCustomText: true,
  },
];

export const KITCHEN_INSTRUCTION_TARGETS = [
  { id: "sauce", label: "Sauce" },
  { id: "sugar", label: "Sugar" },
  { id: "salt", label: "Salt" },
  { id: "spice", label: "Spice" },
  { id: "onion", label: "Onion" },
  { id: "cheese", label: "Cheese" },
  { id: "milk", label: "Milk" },
  { id: "ice", label: "Ice" },
  { id: "other", label: "Other", requiresCustomText: true },
];

export const KITCHEN_CUSTOM_NOTE_MAX = 120;

export function getKitchenInstructionType(typeId) {
  return KITCHEN_INSTRUCTION_TYPES.find((t) => t.id === typeId) || null;
}

export function getKitchenInstructionTarget(targetId) {
  return KITCHEN_INSTRUCTION_TARGETS.find((t) => t.id === targetId) || null;
}

export function formatKitchenInstructionLabel(typeId, targetId, customText = "") {
  const type = getKitchenInstructionType(typeId);
  const target = getKitchenInstructionTarget(targetId);
  const custom = String(customText || "").trim();

  if (!type) return custom;

  if (type.requiresCustomText || !type.template) {
    return custom;
  }

  if (target?.requiresCustomText) {
    return custom;
  }

  if (!target) return custom;

  return type.template
    .replaceAll("{Target}", target.label)
    .replaceAll("{target}", String(target.label).toLowerCase());
}

export function instructionDedupeKey(entry) {
  if (!entry) return "";
  if (entry.typeId === "other" || entry.targetId === "other") {
    return `custom:${String(entry.customText || entry.label || "")
      .trim()
      .toLowerCase()}`;
  }
  return `${entry.typeId}:${entry.targetId}`;
}

export function composeKitchenDescription(instructions = [], customNote = "") {
  const labels = [];
  for (const entry of instructions || []) {
    const label = String(entry?.label || "").trim();
    if (label) labels.push(label);
  }
  const custom = String(customNote || "").trim();
  if (custom) labels.push(custom);
  return labels.join("\n");
}

/**
 * Normalize a cart line for drafts created before kitchen instructions existed.
 */
export function normalizeKitchenCartLine(row) {
  if (!row || typeof row !== "object") return row;

  const rawList = Array.isArray(row.kitchenInstructions)
    ? row.kitchenInstructions
    : [];
  const kitchenInstructions = rawList
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const typeId = String(entry.typeId || "").trim();
      const targetId = String(entry.targetId || "").trim();
      const customText = String(entry.customText || "").trim();
      const label =
        String(entry.label || "").trim() ||
        formatKitchenInstructionLabel(typeId, targetId, customText);
      if (!label) return null;
      return {
        id: String(entry.id || crypto.randomUUID()),
        typeId: typeId || "other",
        targetId: targetId || "other",
        label,
        ...(customText ? { customText } : {}),
      };
    })
    .filter(Boolean);

  let customKitchenNote = String(row.customKitchenNote ?? "").trim();

  // Legacy draft: description only — keep as free-text note.
  if (
    !kitchenInstructions.length &&
    !customKitchenNote &&
    String(row.description || "").trim()
  ) {
    customKitchenNote = String(row.description).trim();
  }

  return {
    ...row,
    kitchenInstructions,
    customKitchenNote,
    description: composeKitchenDescription(
      kitchenInstructions,
      customKitchenNote
    ),
  };
}

export function cartLineHasKitchenNotes(row) {
  return (
    (Array.isArray(row?.kitchenInstructions) &&
      row.kitchenInstructions.length > 0) ||
    Boolean(String(row?.customKitchenNote || "").trim()) ||
    Boolean(String(row?.description || "").trim())
  );
}
