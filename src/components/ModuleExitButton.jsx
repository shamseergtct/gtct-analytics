import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";

export default function ModuleExitButton({ to = "/dashboard", ariaLabel = "Close module" }) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="rounded-full bg-slate-800/50 p-2 text-slate-400 transition-all hover:bg-slate-700 hover:text-white"
      aria-label={ariaLabel}
      title="Close"
    >
      <X size={18} />
    </button>
  );
}
