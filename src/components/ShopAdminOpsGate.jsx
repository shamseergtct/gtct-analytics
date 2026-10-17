import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useShift } from "../context/shift-context";
import { formatIsoDate } from "../utils/dateFormat.js";

/**
 * Blocks a shop_admin from using a shop while another shop_admin holds the
 * open operations shift. Contact details come from the shift binding snapshot.
 */
export default function ShopAdminOpsGate({ children }) {
  const { isShopAdmin, logout } = useAuth();
  const { clients, activeClientId, setActiveClient, activeClientData } =
    useClient();
  const { shopAdminOpsBlock, loadingShift } = useShift();

  if (!isShopAdmin || loadingShift || !shopAdminOpsBlock) {
    return children;
  }

  const otherShops = (clients || []).filter(
    (row) => row.id && row.id !== activeClientId
  );
  const ownerLabel = shopAdminOpsBlock.ownerEmail
    ? `${shopAdminOpsBlock.ownerName} (${shopAdminOpsBlock.ownerEmail})`
    : shopAdminOpsBlock.ownerName;

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg items-center p-6">
      <div className="w-full rounded-2xl border border-amber-800/50 bg-amber-950/30 p-8 text-center shadow-xl">
        <h2 className="text-xl font-semibold text-white">
          Shop shift already open
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-amber-100/90">
          {shopAdminOpsBlock.message}
        </p>
        <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-left text-sm text-slate-300">
          <p>
            <span className="text-slate-500">Shop:</span>{" "}
            <span className="font-medium text-white">
              {activeClientData?.name || activeClientId}
            </span>
          </p>
          <p className="mt-1.5">
            <span className="text-slate-500">Opened by:</span>{" "}
            <span className="font-medium text-white">{ownerLabel}</span>
          </p>
          {shopAdminOpsBlock.businessDate ? (
            <p className="mt-1.5">
              <span className="text-slate-500">Business date:</span>{" "}
              <span className="font-medium text-white">
                {formatIsoDate(shopAdminOpsBlock.businessDate) ||
                  shopAdminOpsBlock.businessDate}
              </span>
            </p>
          ) : null}
          {shopAdminOpsBlock.ownerEmail ? (
            <p className="mt-3">
              <a
                href={`mailto:${shopAdminOpsBlock.ownerEmail}`}
                className="font-semibold text-sky-300 underline hover:text-sky-200"
              >
                Contact {shopAdminOpsBlock.ownerName || "them"}
              </a>
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex flex-col gap-2">
          {otherShops.length ? (
            <label className="text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Switch shop
              <select
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                value=""
                onChange={(event) => {
                  const next = event.target.value;
                  if (next) setActiveClient(next);
                }}
              >
                <option value="">Select another shop…</option>
                {otherShops.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name || row.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => logout()}
            className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
