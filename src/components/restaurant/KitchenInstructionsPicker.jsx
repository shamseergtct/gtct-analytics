import { useId, useState } from "react";
import { ChevronDown, ChevronUp, Pencil, X } from "lucide-react";
import {
  KITCHEN_CUSTOM_NOTE_MAX,
  KITCHEN_INSTRUCTION_TARGETS,
  KITCHEN_INSTRUCTION_TYPES,
  composeKitchenDescription,
  formatKitchenInstructionLabel,
  getKitchenInstructionTarget,
  getKitchenInstructionType,
  instructionDedupeKey,
} from "../../utils/kitchenInstructions.js";

const GTCT_BLUE = "#0B539E";
const GTCT_GREEN = "#99AC3E";

/**
 * Two-step kitchen instructions selector for a single cart line.
 * Collapsed by default: shows chips only. Expands to edit; collapses after add.
 */
export default function KitchenInstructionsPicker({
  itemName = "item",
  instructions = [],
  customNote = "",
  onChange,
  open = false,
  onOpenChange,
  types = KITCHEN_INSTRUCTION_TYPES,
  targets = KITCHEN_INSTRUCTION_TARGETS,
}) {
  const baseId = useId();
  const [typeId, setTypeId] = useState("");
  const [otherTargetPending, setOtherTargetPending] = useState(false);
  const [pendingCustom, setPendingCustom] = useState("");
  const [customDraft, setCustomDraft] = useState(() => customNote || "");
  const [pickerError, setPickerError] = useState("");

  const selectedType = getKitchenInstructionType(typeId);
  const needsCustomForType = Boolean(selectedType?.requiresCustomText);
  const showTargets = Boolean(typeId) && !needsCustomForType;
  const showCustomInput = needsCustomForType || otherTargetPending;
  const hasData =
    (instructions?.length || 0) > 0 ||
    Boolean(String(customNote || "").trim());

  function setOpen(next) {
    onOpenChange?.(Boolean(next));
    if (!next) {
      setTypeId("");
      setOtherTargetPending(false);
      setPendingCustom("");
      setPickerError("");
      setCustomDraft(customNote || "");
    }
  }

  function emit(nextInstructions, nextCustom) {
    const kitchenInstructions = nextInstructions;
    const customKitchenNote = String(nextCustom || "").trim();
    onChange?.({
      kitchenInstructions,
      customKitchenNote,
      description: composeKitchenDescription(
        kitchenInstructions,
        customKitchenNote
      ),
    });
  }

  function resetStep(keepType = false) {
    if (!keepType) setTypeId("");
    setOtherTargetPending(false);
    setPendingCustom("");
    setPickerError("");
  }

  function addInstruction({ nextTypeId, nextTargetId, customText = "" }) {
    const label = formatKitchenInstructionLabel(
      nextTypeId,
      nextTargetId,
      customText
    );
    if (!label) {
      setPickerError("Enter the custom instruction text.");
      return false;
    }
    const entry = {
      id: crypto.randomUUID(),
      typeId: nextTypeId,
      targetId: nextTargetId || "other",
      label,
      ...(String(customText || "").trim()
        ? { customText: String(customText).trim() }
        : {}),
    };
    const key = instructionDedupeKey(entry);
    if (
      (instructions || []).some((row) => instructionDedupeKey(row) === key)
    ) {
      setPickerError("That instruction is already on this item.");
      return false;
    }
    emit([...(instructions || []), entry], customDraft);
    resetStep(false);
    setOpen(false);
    return true;
  }

  function onTargetClick(targetId) {
    const target = getKitchenInstructionTarget(targetId);
    if (!target) return;
    if (target.requiresCustomText) {
      setOtherTargetPending(true);
      setPendingCustom("");
      setPickerError("");
      return;
    }
    setOtherTargetPending(false);
    addInstruction({
      nextTypeId: typeId,
      nextTargetId: targetId,
    });
  }

  function confirmCustomInstruction() {
    const text = String(pendingCustom || "").trim();
    if (!text) {
      setPickerError("Enter the custom instruction text.");
      return;
    }
    if (text.length > KITCHEN_CUSTOM_NOTE_MAX) {
      setPickerError(
        `Keep custom text under ${KITCHEN_CUSTOM_NOTE_MAX} characters.`
      );
      return;
    }
    addInstruction({
      nextTypeId: typeId || "other",
      nextTargetId: "other",
      customText: text,
    });
  }

  function removeInstruction(id) {
    emit(
      (instructions || []).filter((row) => row.id !== id),
      customNote
    );
  }

  function commitCustomNote() {
    const text = String(customDraft || "").trim();
    if (text.length > KITCHEN_CUSTOM_NOTE_MAX) {
      setPickerError(
        `Keep notes under ${KITCHEN_CUSTOM_NOTE_MAX} characters.`
      );
      return;
    }
    setPickerError("");
    emit(instructions || [], text);
    setOpen(false);
  }

  const chipBase =
    "rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors active:scale-[0.98]";
  const chipIdle =
    "border-slate-700 bg-slate-950 text-slate-200 hover:border-slate-500";
  const chipSelected = "border-transparent text-white";

  return (
    <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/40">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          {(instructions || []).length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {instructions.map((entry) => (
                <li key={entry.id}>
                  <span
                    className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-slate-950"
                    style={{ backgroundColor: GTCT_GREEN }}
                  >
                    <span className="truncate">{entry.label}</span>
                    <button
                      type="button"
                      onClick={() => removeInstruction(entry.id)}
                      className="rounded-full p-0.5 text-slate-900/70 hover:bg-black/10"
                      aria-label={`Remove ${entry.label} from ${itemName}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {customNote ? (
            <p className="truncate text-xs text-slate-400">{customNote}</p>
          ) : null}
          {!hasData && !open ? (
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              Kitchen instructions
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 px-2 py-1.5 text-xs font-semibold text-slate-200"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={`${baseId}-body`}
        >
          {open ? (
            <>
              <ChevronUp size={14} />
              Close
            </>
          ) : (
            <>
              {hasData ? <Pencil size={12} /> : <ChevronDown size={14} />}
              {hasData ? "Edit" : "Add"}
            </>
          )}
        </button>
      </div>

      {open ? (
        <div
          id={`${baseId}-body`}
          className="space-y-2 border-t border-slate-800 px-3 pb-3 pt-2"
        >
          <div>
            <p className="mb-1 text-[10px] uppercase text-slate-500">
              1. Instruction type
            </p>
            <div className="flex flex-wrap gap-1.5">
              {types.map((type) => {
                const selected = typeId === type.id;
                return (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => {
                      setTypeId(type.id);
                      setOtherTargetPending(false);
                      setPendingCustom("");
                      setPickerError("");
                    }}
                    className={`${chipBase} ${selected ? chipSelected : chipIdle}`}
                    style={
                      selected ? { backgroundColor: GTCT_BLUE } : undefined
                    }
                  >
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          {showTargets ? (
            <div>
              <p className="mb-1 text-[10px] uppercase text-slate-500">
                2. Applies to
              </p>
              <div className="flex flex-wrap gap-1.5">
                {targets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => onTargetClick(target.id)}
                    className={`${chipBase} ${chipIdle}`}
                  >
                    {target.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {showCustomInput ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={pendingCustom}
                maxLength={KITCHEN_CUSTOM_NOTE_MAX}
                onChange={(e) => setPendingCustom(e.target.value)}
                placeholder="Type custom instruction…"
                className="h-9 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100"
                aria-label={`Custom kitchen instruction for ${itemName}`}
              />
              <button
                type="button"
                onClick={confirmCustomInstruction}
                className="shrink-0 rounded-lg px-3 text-xs font-semibold text-white"
                style={{ backgroundColor: GTCT_BLUE }}
              >
                Add
              </button>
            </div>
          ) : null}

          {typeId ? (
            <button
              type="button"
              onClick={() => resetStep(false)}
              className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
            >
              Cancel selection
            </button>
          ) : null}

          <label className="block">
            <span className="mb-0.5 block text-[10px] uppercase text-slate-500">
              Extra note (optional)
            </span>
            <input
              type="text"
              value={customDraft}
              maxLength={KITCHEN_CUSTOM_NOTE_MAX}
              onChange={(e) => setCustomDraft(e.target.value)}
              onBlur={commitCustomNote}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCustomNote();
                }
              }}
              placeholder="Enter description..."
              className="h-9 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100"
              aria-label={`Extra kitchen note for ${itemName}`}
            />
          </label>

          {pickerError ? (
            <p className="text-xs text-amber-300">{pickerError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
