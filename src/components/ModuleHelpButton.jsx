import { Link, useLocation } from "react-router-dom";
import { CircleHelp } from "lucide-react";
import { helpModuleIdFromPath } from "../utils/helpContent.js";

/**
 * Compact help entry for module headers.
 * Links to /help?module=<id> for the current page when possible.
 */
export default function ModuleHelpButton({
  moduleId = "",
  ariaLabel = "Open help",
  className = "",
}) {
  const location = useLocation();
  const id = moduleId || helpModuleIdFromPath(location.pathname);
  const to = id ? `/help?module=${encodeURIComponent(id)}` : "/help";

  return (
    <Link
      to={to}
      className={`inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950 px-2.5 text-sm font-medium text-slate-200 hover:bg-slate-900 hover:text-white ${className}`}
      aria-label={ariaLabel}
      title="Help"
    >
      <CircleHelp size={15} />
      <span className="hidden sm:inline">Help</span>
    </Link>
  );
}
