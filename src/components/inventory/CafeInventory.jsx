import ItemEntryShell, { CoreItemFields } from "./ItemEntryShell.jsx";
import { LABEL_CLASS } from "./inventoryStyles.js";

/** Café / restaurant item entry — usage unit + recipe notes. */
export default function CafeInventory(props) {
  const { saveItem, recipeNotes, setRecipeNotes } = props;

  return (
    <ItemEntryShell
      {...props}
      onSubmit={saveItem}
      badge={<span className="text-amber-400/80">Café / restaurant</span>}
      title="Item Entry"
    >
      <CoreItemFields {...props} itemCodePlaceholder="Code" />

      <div className="md:col-span-2">
        <label className={LABEL_CLASS}>Recipe / Components</label>
        <textarea
          value={recipeNotes || ""}
          onChange={(e) => setRecipeNotes(e.target.value)}
          rows={3}
          className="box-border w-full rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          placeholder="Recipe notes"
        />
      </div>
    </ItemEntryShell>
  );
}
