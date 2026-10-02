import { Link, useSearchParams } from "react-router-dom";
import { CircleHelp, ExternalLink } from "lucide-react";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import { HELP_MODULES, getHelpModule } from "../utils/helpContent.js";

export default function Help() {
  const [searchParams, setSearchParams] = useSearchParams();
  const moduleId = String(searchParams.get("module") || "").trim();
  const active = moduleId ? getHelpModule(moduleId) : null;
  const modules = active ? [active] : HELP_MODULES;

  function selectModule(id) {
    if (!id) {
      setSearchParams({}, { replace: true });
      return;
    }
    setSearchParams({ module: id }, { replace: true });
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 inline-flex items-center gap-2 text-sky-400/90">
              <CircleHelp size={18} />
              <span className="text-xs font-semibold uppercase tracking-wide">
                Help Center
              </span>
            </div>
            <h1 className="text-2xl font-semibold text-slate-100">
              {active ? active.title : "Module Help"}
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {active
                ? active.summary
                : "Shortcuts, workflows, and tips for each module."}
            </p>
          </div>
          <ModuleExitButton ariaLabel="Close help" />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => selectModule("")}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              !active
                ? "border-sky-700/60 bg-sky-950/40 text-sky-200"
                : "border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-900"
            }`}
          >
            All modules
          </button>
          {HELP_MODULES.map((module) => (
            <button
              key={module.id}
              type="button"
              onClick={() => selectModule(module.id)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                active?.id === module.id
                  ? "border-sky-700/60 bg-sky-950/40 text-sky-200"
                  : "border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-900"
              }`}
            >
              {module.title}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-5">
          {modules.map((module) => (
            <section
              key={module.id}
              id={`help-${module.id}`}
              className="rounded-2xl border border-slate-800 bg-slate-950/50 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-100">
                    {module.title}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">{module.summary}</p>
                </div>
                {module.path ? (
                  <Link
                    to={module.path}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-900"
                  >
                    Open module
                    <ExternalLink size={13} />
                  </Link>
                ) : null}
              </div>

              <div className="mt-4 space-y-4">
                {module.sections.map((section) => (
                  <div key={section.title}>
                    <h3 className="text-sm font-semibold text-slate-200">
                      {section.title}
                    </h3>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-300">
                      {section.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
