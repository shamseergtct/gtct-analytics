/* Shared Monitor board: lane mapping + card/board render. No money writes. */
import {
  appendOrderLineItem,
  formatSplitGroupTotalLabel,
  groupLinesBySplit,
} from "./orderLineItems.js";

/** Pending delivery older than this (minutes) shows red "late" age. */
export const DELIVERY_LATE_AFTER_MINUTES = 30;

function node(tag, className, textValue) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textValue !== undefined) e.textContent = String(textValue);
  return e;
}

/** Inline confirm next to the action (card/button) — faster than a centered browser dialog. */
function confirmNear(anchor, message, { confirmLabel = "OK", cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll(".board-inline-confirm").forEach((el) => el.remove());
    const host =
      anchor?.closest?.(".monitor-order, .monitor-card-actions, .monitor-review-actions") ||
      anchor?.parentElement ||
      document.body;
    const pop = node("div", "board-inline-confirm");
    pop.setAttribute("role", "alertdialog");
    pop.setAttribute("aria-modal", "true");
    pop.append(node("p", "board-inline-confirm-msg", message));
    const actions = node("div", "board-inline-confirm-actions");
    const cancel = node("button", "btn ghost board-inline-confirm-cancel", cancelLabel);
    cancel.type = "button";
    const ok = node("button", "btn primary board-inline-confirm-ok", confirmLabel);
    ok.type = "button";
    actions.append(cancel, ok);
    pop.append(actions);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      pop.remove();
      resolve(value);
      if (value === false) anchor?.focus?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onPointer = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) finish(false);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);

    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.append(pop);
    ok.focus();
  });
}

function stageBadge(text, theme) {
  return node("span", `monitor-pill ${theme || ""}`, text);
}

function titleCase(value) {
  return String(value || "").replaceAll("_", " ");
}

function statusClass(value) {
  if (["FINISHED", "READY_FOR_DELIVERY", "DELIVERED", "PAID"].includes(value)) return "is-success";
  if (["CANCEL_REQUESTED", "CANCELLED", "RECHECK", "REJECTED", "VOID"].includes(value)) return "is-danger";
  if (["PREPARING", "ACCEPTED", "PROCESSING"].includes(value)) return "is-progress";
  if (["CREDIT", "CREDIT_APPROVED"].includes(value)) return "is-credit";
  return "is-neutral";
}

export const TYPE_ORDER = ["DELIVERY", "TAKEAWAY", "COUNTER", "TABLE", "CAR_HOP"];
export const LANE_ORDER = [
  { key: "pending", deliveryLabel: "Pending", otherLabel: "Pending" },
  { key: "ready", deliveryLabel: "Ready for delivery", otherLabel: "Ready" },
  { key: "out", deliveryLabel: "Out for delivery", otherLabel: "Out for delivery" },
  { key: "delivered", deliveryLabel: "Delivered", otherLabel: "Completed" },
];

export function orderTypeKey(order) {
  return String(order.fulfillmentBehavior || order.orderTypeName || "OTHER").toUpperCase();
}

/** Lane for board columns: pending | ready | out | delivered */
export function boardLane(order) {
  const life = order.deliveryLifecycle || {};
  const dispatch = order.dispatch || {};
  const prepRaw = order.preparation?.stage || "NEW";
  const claimed = Boolean(order.deliveryBoyName);
  const type = orderTypeKey(order);

  if (order.fulfillmentStatus === "VOID") return "pending";

  if (type === "DELIVERY") {
    if (life.status === "DELIVERED") return "delivered";
    if (["CANCELLED", "CANCEL_REQUESTED"].includes(life.status)) return "pending";
    if (claimed) return "out";
    if (dispatch.ready) return "ready";
    return "pending";
  }

  if (prepRaw === "FINISHED" && String(order.paymentStatus || "").toUpperCase() === "PAID") {
    return "delivered";
  }
  if (prepRaw === "FINISHED") return "ready";
  return "pending";
}

/** Lowest token first within a type / lane block. */
export function compareOrders(a, b) {
  const tokenA = Number(a.tokenNumber);
  const tokenB = Number(b.tokenNumber);
  const aOk = Number.isFinite(tokenA) && a.tokenNumber != null && a.tokenNumber !== "";
  const bOk = Number.isFinite(tokenB) && b.tokenNumber != null && b.tokenNumber !== "";
  if (aOk && bOk && tokenA !== tokenB) return tokenA - tokenB;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  return String(a.orderNumber || "").localeCompare(String(b.orderNumber || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Same block, then same road, then token — for Delivery board/list. */
export function compareByBlockRoad(a, b) {
  const block = String(a.blockNumber || "").localeCompare(String(b.blockNumber || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (block) return block;
  const road = String(a.roadNumber || "").localeCompare(String(b.roadNumber || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (road) return road;
  const building = String(a.buildingNumber || "").localeCompare(
    String(b.buildingNumber || ""),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
  if (building) return building;
  return compareOrders(a, b);
}

function appendSortedCards(grid, rows, ctx, sortMode) {
  const compare = sortMode === "block-road" ? compareByBlockRoad : compareOrders;
  const sorted = [...rows].sort(compare);
  if (sortMode !== "block-road") {
    for (const order of sorted) grid.append(renderOrderCard(order, ctx));
    return;
  }
  let lastKey = null;
  for (const order of sorted) {
    const key = `${order.blockNumber || "—"}|${order.roadNumber || "—"}`;
    if (key !== lastKey) {
      lastKey = key;
      const label = [
        order.blockNumber ? `Block ${order.blockNumber}` : "Block not recorded",
        order.roadNumber ? `Road ${order.roadNumber}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      grid.append(node("p", "monitor-route-group", label));
    }
    grid.append(renderOrderCard(order, ctx));
  }
}

function smallBadge(value, className) {
  return stageBadge(value, className || "is-neutral");
}

/** Display API totalCents only — no recalculation. */
function formatApiTotal(order) {
  const label = order.currencyLabel || order.currencyCode || "BD";
  const decimals = Number(order.currencyDecimals != null ? order.currencyDecimals : 3);
  const cents = Number(order.totalCents || 0);
  const factor = 10 ** decimals;
  return `${label} ${(cents / factor).toFixed(decimals)}`;
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

function shortAddress(order) {
  return [
    order.blockNumber && `Blk ${order.blockNumber}`,
    order.roadNumber && `Rd ${order.roadNumber}`,
    order.buildingNumber && `Bldg ${order.buildingNumber}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function appendFullDeliveryAddress(host, order) {
  const chunks = [];
  if (order.blockNumber) {
    const part = node("span", "monitor-addr-part");
    part.append(document.createTextNode("Block "));
    part.append(node("strong", "monitor-block-num", String(order.blockNumber)));
    chunks.push(part);
  }
  if (order.roadNumber) {
    chunks.push(node("span", "monitor-addr-part", `Road ${order.roadNumber}`));
  }
  if (order.buildingNumber) {
    chunks.push(node("span", "monitor-addr-part", `Building ${order.buildingNumber}`));
  }
  if (order.addressNote) {
    chunks.push(node("span", "monitor-addr-part", String(order.addressNote)));
  }
  if (!chunks.length) return false;
  // Separator lives inside each following part so it never dangles alone on a line.
  chunks.forEach((part, i) => {
    if (i) {
      const wrapped = node("span", "monitor-addr-part");
      wrapped.append(node("span", "monitor-addr-sep", " · "));
      while (part.firstChild) wrapped.append(part.firstChild);
      host.append(wrapped);
    } else {
      host.append(part);
    }
  });
  return true;
}

function ensureBoardDetailDialog() {
  let dlg = document.getElementById("board-detail-dialog");
  if (dlg) return dlg;
  dlg = node("dialog", "board-detail-dialog");
  dlg.id = "board-detail-dialog";
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-labelledby", "board-detail-title");
  const panel = node("div", "board-detail-panel");
  const head = node("header", "board-detail-head");
  const title = node("h2", "board-detail-title", "Details");
  title.id = "board-detail-title";
  const closeBtn = node("button", "btn ghost board-detail-close", "Close");
  closeBtn.type = "button";
  head.append(title, closeBtn);
  const body = node("div", "board-detail-body");
  const foot = node("footer", "board-detail-footer");
  panel.append(head, body, foot);
  dlg.append(panel);
  document.body.append(dlg);
  closeBtn.addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => {
    const el = dlg._returnFocus;
    dlg._returnFocus = null;
    if (el && typeof el.focus === "function") el.focus();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  return dlg;
}

function canEditLikeOrdersList(session) {
  if (session.role === "admin" || session.role === "device") return true;
  return (session.permissions || []).includes("sales.order.create");
}

function editBlockReason(order, session) {
  const lane = boardLane(order);
  if (!canEditLikeOrdersList(session)) return "No permission to edit orders.";
  if (order.fulfillmentStatus === "VOID") return "Voided — cannot edit.";
  if (String(order.paymentStatus || "").toUpperCase() !== "UNPAID" || order.hasAllocations) {
    return "Paid or settled — cannot edit.";
  }
  if (lane === "out") return "Out for delivery — cannot edit.";
  if (lane === "delivered") return "Completed / delivered — cannot edit.";
  return "";
}

function moneyLabel(order, cents) {
  const label = String(order.currencyLabel || order.currencyCode || "BD")
    .trim()
    .replace(/:$/, "");
  const decimals = Number(order.currencyDecimals != null ? order.currencyDecimals : 3);
  const factor = 10 ** decimals;
  return `${label} ${(Number(cents || 0) / factor).toFixed(decimals)}`;
}

function renderBoardDetailLoaded(dlg, listOrder, detail, ctx) {
  const order = { ...listOrder, ...detail };
  const body = dlg.querySelector(".board-detail-body");
  const foot = dlg.querySelector(".board-detail-footer");
  body.replaceChildren();
  foot.replaceChildren();

  const isDelivery = orderTypeKey(order) === "DELIVERY";
  if (isDelivery) {
    const contact = node("section", "board-detail-section board-detail-contact");
    const name = String(order.customerName || "").trim();
    const phone = String(order.customerPhone || "").trim();
    if (name) contact.append(node("strong", "board-detail-customer", name));
    if (phone) {
      const tel = node("a", "board-detail-phone", phone);
      tel.href = `tel:${phone.replace(/[^\d+]/g, "")}`;
      contact.append(tel);
    }
    const addr = deliveryAddressPlain(order);
    if (addr) contact.append(node("p", "board-detail-address", addr));
    if (contact.childNodes.length) body.append(contact);
  }

  const pay = String(order.paymentStatus || "UNPAID").toUpperCase();
  const payChip = () =>
    smallBadge(
      pay === "PAID" ? "PAID" : pay === "CREDIT" ? "CREDIT" : pay === "PARTIAL" ? "PARTIAL" : "UNPAID",
      pay === "PAID" ? "is-success" : pay === "CREDIT" ? "is-credit" : "is-neutral"
    );

  const sums = node("section", "board-detail-section board-detail-sums board-detail-sums-sticky");
  const grouped = groupLinesBySplit(order.lines || []);
  const addMutedRow = (label, cents) => {
    const row = node("div", "board-detail-sum-row board-detail-sum-muted");
    row.append(node("span", "", label));
    row.append(node("span", "", moneyLabel(order, cents)));
    sums.append(row);
  };

  if (grouped.isSplit) {
    const top = node("div", "board-detail-split-top");
    top.append(
      node("strong", "board-detail-split-banner", `Split into ${grouped.splitCount} bills`)
    );
    const totalRight = node("span", "board-detail-total-wrap");
    totalRight.append(node("strong", "board-detail-grand-total", moneyLabel(order, order.totalCents)));
    totalRight.append(payChip());
    top.append(totalRight);
    sums.append(top);
    addMutedRow("Subtotal", order.goodsCents);
    if (Number(order.deliveryChargeCents || 0) !== 0) {
      addMutedRow("Delivery charge", order.deliveryChargeCents);
    }
  } else {
    addMutedRow("Subtotal", order.goodsCents);
    if (Number(order.deliveryChargeCents || 0) !== 0) {
      addMutedRow("Delivery charge", order.deliveryChargeCents);
    }
    const totalRow = node("div", "board-detail-sum-row is-total");
    totalRow.append(node("span", "", "Total"));
    const totalRight = node("span", "board-detail-total-wrap");
    totalRight.append(node("strong", "", moneyLabel(order, order.totalCents)));
    totalRight.append(payChip());
    totalRow.append(totalRight);
    sums.append(totalRow);
  }
  body.append(sums);

  const items = node("section", "board-detail-section");
  if (!grouped.isSplit) items.append(node("h3", "board-detail-h", "Items"));
  const decimals = Number(order.currencyDecimals != null ? order.currencyDecimals : 3);
  const bareAmount = (cents) => {
    const factor = 10 ** decimals;
    return (Number(cents || 0) / factor).toFixed(decimals);
  };
  const lineOpts = {
    formatMoney: (cents) => moneyLabel(order, cents),
    formatSignedMoney: (cents) => {
      const n = Number(cents || 0);
      if (n === 0) return moneyLabel(order, 0);
      return `${n > 0 ? "+" : ""}${moneyLabel(order, n)}`;
    },
  };
  const splitLineOpts = { ...lineOpts, formatLineMoney: bareAmount };
  if (!(order.lines || []).length) {
    items.append(node("p", "board-detail-line", "No line items."));
  } else if (grouped.isSplit) {
    for (const g of grouped.groups) {
      if (!g.lines.length) continue;
      const block = node("section", "board-detail-split");
      const head = node("header", "board-detail-split-head");
      const title =
        g.splitNo != null ? `Order ${g.splitNo}` : "Other items";
      head.append(node("strong", "board-detail-split-title", title));
      const right = node("span", "board-detail-split-right");
      right.append(
        node(
          "strong",
          "board-detail-split-total",
          formatSplitGroupTotalLabel(moneyLabel(order, g.totalCents))
        )
      );
      head.append(right);
      block.append(head);
      const list = node("div", "oli-lines board-detail-lines");
      for (const line of g.lines) appendOrderLineItem(list, line, splitLineOpts);
      block.append(list);
      items.append(block);
    }
  } else {
    const list = node("div", "oli-lines board-detail-lines");
    for (const line of order.lines || []) appendOrderLineItem(list, line, lineOpts);
    items.append(list);
  }
  body.append(items);

  const modalCtx = {
    ...ctx,
    onRefresh: async () => {
      if (dlg.open) dlg.close();
      await ctx.onRefresh();
    },
  };
  // Stations / dispatch / delivery-review actions (unchanged behaviour).
  appendDetailBody(body, order, modalCtx);

  // Replace "Open Orders · Cash/Bank/Credit" style links with Take Payment when allowed.
  for (const a of [...body.querySelectorAll("a.btn")]) {
    const t = (a.textContent || "").toLowerCase();
    if (t.includes("cash") || t.includes("record/check payment") || t.includes("record verified")) {
      a.remove();
    }
  }

  const reason = editBlockReason(order, ctx.session);
  if (!reason) {
    const edit = node("a", "btn primary board-detail-edit", "Edit order");
    edit.href = `/?editOrder=${encodeURIComponent(order.orderId)}`;
    foot.append(edit);
  } else {
    foot.append(node("p", "board-detail-edit-reason", reason));
  }

  const canPay =
    (ctx.session.permissions || []).includes("sales.payment.receive") &&
    order.fulfillmentStatus !== "VOID" &&
    Number(order.unallocatedCents ?? order.totalCents) > 0;
  if (canPay) {
    const payBtn = node("a", "btn ghost board-detail-pay", "Take payment");
    payBtn.href = `/?payOrder=${encodeURIComponent(order.orderId)}`;
    foot.append(payBtn);
  }
}

async function openBoardDetailModal(order, ctx, triggerBtn) {
  const dlg = ensureBoardDetailDialog();
  dlg._returnFocus = triggerBtn;
  const title = dlg.querySelector("#board-detail-title");
  if (title) title.textContent = `Details · ${order.orderNumber || "Order"}`;
  const body = dlg.querySelector(".board-detail-body");
  const foot = dlg.querySelector(".board-detail-footer");
  body.replaceChildren(node("p", "board-detail-loading", "Loading order…"));
  foot.replaceChildren();
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  dlg.querySelector(".board-detail-close")?.focus();

  const load = async () => {
    body.replaceChildren(node("p", "board-detail-loading", "Loading order…"));
    foot.replaceChildren();
    try {
      const result = await ctx.api(
        `/v1/order-monitor/${encodeURIComponent(order.orderId)}`,
        "GET"
      );
      if (!result.ok) {
        const err = node("div", "board-detail-error");
        err.append(
          node("p", "", result.json?.error || "Could not load order details.")
        );
        const retry = node("button", "btn primary", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => void load());
        err.append(retry);
        body.replaceChildren(err);
        return;
      }
      const detail = result.json?.order || result.json || {};
      if (!Array.isArray(detail.lines)) {
        body.replaceChildren(
          node(
            "p",
            "board-detail-error",
            "Order detail response has no line items (lines[]). Cannot show full order."
          )
        );
        return;
      }
      renderBoardDetailLoaded(dlg, order, detail, ctx);
    } catch {
      const err = node("div", "board-detail-error");
      err.append(node("p", "", "Connection lost."));
      const retry = node("button", "btn primary", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => void load());
      err.append(retry);
      body.replaceChildren(err);
    }
  };
  void load();
}

function ageMinutes(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function appendActionsRow(article, order, ctx) {
  const { api, onRefresh } = ctx;
  const dispatch = order.dispatch || {};
  const row4 = node("div", "monitor-card-row monitor-card-actions");
  const canDispatch = (ctx.session.permissions || []).includes("sales.orders.dispatch");
  let actionBtn = null;
  if (order.fulfillmentStatus !== "VOID" && dispatch.canMarkReady && canDispatch) {
    actionBtn = node("button", "btn primary monitor-ready", "Ready for delivery");
    actionBtn.type = "button";
    actionBtn.addEventListener("click", async () => {
      const ok = await confirmNear(
        actionBtn,
        `Confirm all items packed for ${order.orderNumber}?`,
        { confirmLabel: "Ready", cancelLabel: "Cancel" }
      );
      if (!ok) return;
      actionBtn.disabled = true;
      const result = await api(
        `/v1/order-monitor/${encodeURIComponent(order.orderId)}/ready`,
        "POST",
        { expectedRevision: dispatch.revision }
      );
      if (!result.ok) window.alert(result.json.error || "Could not confirm. Refresh and review.");
      await onRefresh();
    });
  } else if (order.fulfillmentStatus !== "VOID" && dispatch.canUnmarkReady && canDispatch) {
    actionBtn = node("button", "btn ghost monitor-ready monitor-unready", "Back to pending");
    actionBtn.type = "button";
    actionBtn.addEventListener("click", async () => {
      const ok = await confirmNear(
        actionBtn,
        `Move ${order.orderNumber} back to Pending?`,
        { confirmLabel: "Move back", cancelLabel: "Cancel" }
      );
      if (!ok) return;
      actionBtn.disabled = true;
      const result = await api(
        `/v1/order-monitor/${encodeURIComponent(order.orderId)}/unready`,
        "POST",
        { expectedRevision: dispatch.revision }
      );
      if (!result.ok)
        window.alert(result.json.error || "Could not update status. Refresh and review.");
      await onRefresh();
    });
  }
  if (actionBtn) row4.append(actionBtn);
  else row4.append(node("span", "monitor-footer-spacer", ""));

  const detailsBtn = node("button", "btn ghost monitor-detail-trigger", "Details");
  detailsBtn.type = "button";
  detailsBtn.addEventListener("click", () => {
    openBoardDetailModal(order, ctx, detailsBtn);
  });
  row4.append(detailsBtn);
  article.append(row4);
}

function deliveryAddressPlain(order) {
  return [
    order.blockNumber && `Block ${order.blockNumber}`,
    order.roadNumber && `Road ${order.roadNumber}`,
    order.buildingNumber && `Building ${order.buildingNumber}`,
    order.addressNote && String(order.addressNote),
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderDeliveryCard(order, ctx) {
  const article = node("article", "monitor-order monitor-order--compact monitor-order--delivery");
  const lane = boardLane(order);
  const riderPay = order.deliveryPaymentReport || {};
  const life = order.deliveryLifecycle || {};
  const mins = ageMinutes(order.createdAt);
  const ago = timeAgo(order.createdAt);
  const late = lane === "pending" && mins != null && mins > DELIVERY_LATE_AFTER_MINUTES;

  // Slot 1 — token + age
  const tokenRow = node("div", "monitor-card-row monitor-delivery-slot monitor-delivery-head");
  const tokenText =
    Number.isFinite(Number(order.tokenNumber)) && order.tokenNumber != null
      ? `TOKEN ${String(order.tokenNumber).padStart(3, "0")}`
      : "TOKEN —";
  tokenRow.append(node("h2", "monitor-token-hero", tokenText));
  const ageEl = node(
    "span",
    late ? "monitor-ago monitor-ago--late monitor-delivery-age" : "monitor-ago monitor-delivery-age",
    ago || "\u00a0"
  );
  if (late) {
    ageEl.append(document.createTextNode(" "));
    ageEl.append(node("span", "monitor-late-label", "late"));
  }
  tokenRow.append(ageEl);
  article.append(tokenRow);

  // Slot 2 — invoice
  const invoiceRow = node("div", "monitor-card-row monitor-delivery-slot monitor-delivery-invoice");
  invoiceRow.append(node("span", "monitor-invoice-muted", order.orderNumber || "\u00a0"));
  article.append(invoiceRow);

  // Slot 3 — name + phone (always)
  const customer = String(order.customerName || "").trim();
  const phone = String(order.customerPhone || "").trim();
  const custRow = node("div", "monitor-card-row monitor-delivery-slot monitor-delivery-customer");
  custRow.append(node("strong", "monitor-customer-name", customer || "\u00a0"));
  if (phone) {
    const tel = node("a", "monitor-customer-phone", phone);
    tel.href = `tel:${phone.replace(/[^\d+]/g, "")}`;
    custRow.append(tel);
  } else {
    custRow.append(node("span", "monitor-customer-phone monitor-slot-empty", "\u00a0"));
  }
  article.append(custRow);

  // Slot 4 — address (always 2-line slot)
  const addrPlain = deliveryAddressPlain(order);
  const addrRow = node("div", "monitor-card-row monitor-delivery-slot monitor-delivery-address");
  addrRow.append(node("span", "monitor-pin", "📍"));
  const addr = node("span", "monitor-address-full");
  if (addrPlain) {
    addr.title = addrPlain;
    appendFullDeliveryAddress(addr, order);
  } else {
    addr.append(document.createTextNode("\u00a0"));
  }
  addrRow.append(addr);
  article.append(addrRow);

  // Slot 5 — rider (always)
  const riderRow = node("div", "monitor-card-row monitor-delivery-slot monitor-rider-prominent");
  riderRow.textContent = order.deliveryBoyName ? `Rider: ${order.deliveryBoyName}` : "\u00a0";
  article.append(riderRow);

  // Slot 6 — collect / paid
  const rowPay = node("div", "monitor-card-row monitor-delivery-slot monitor-delivery-pay");
  const credit =
    order.shopCreditAuthorization?.state === "APPROVED" || riderPay.shopAuthorized;
  const payment = String(order.paymentStatus || "UNPAID").toUpperCase();
  if (order.fulfillmentStatus === "VOID") {
    rowPay.append(smallBadge("VOID", "is-danger"));
  } else if (payment === "PAID") {
    rowPay.append(node("strong", "monitor-paid-ok", "Paid ✓"));
  } else if (credit || payment === "CREDIT") {
    rowPay.append(node("strong", "monitor-collect", `Collect ${formatApiTotal(order)}`));
    rowPay.append(smallBadge("CREDIT", "is-credit"));
  } else if (payment === "PARTIAL") {
    rowPay.append(node("strong", "monitor-collect", `Collect ${formatApiTotal(order)}`));
    rowPay.append(smallBadge("PARTIAL", "is-progress"));
  } else {
    rowPay.append(node("strong", "monitor-collect", `Collect ${formatApiTotal(order)}`));
    rowPay.append(smallBadge("UNPAID", "is-neutral"));
  }
  const review = order.deliverySplitReview;
  if (review && (review.shopPaid.state === "PENDING" || review.credit.state === "PENDING")) {
    // Delivery boy reported shop-paid / credit: the cashier must approve it.
    rowPay.append(smallBadge("NEEDS APPROVAL", "is-danger"));
  } else if (review?.credit.state === "REJECTED") {
    rowPay.append(smallBadge("CREDIT REJECTED", "is-danger"));
  }
  if (order.deliveryReleaseRequest) {
    // Delivery boy wants to give the order back: the cashier must allow or refuse.
    rowPay.append(smallBadge("RELEASE REQUEST", "is-danger"));
  }
  if (life.status === "CANCEL_REQUESTED") {
    rowPay.append(smallBadge("CANCEL REQUESTED", "is-danger"));
  } else if (life.status === "CANCELLED") {
    rowPay.append(smallBadge("CANCELLED", "is-danger"));
  }
  article.append(rowPay);

  // Slot 7 — actions (pinned to bottom via CSS)
  appendActionsRow(article, order, ctx);
  return article;
}

/**
 * Delivery boy asked (from the Delivery App) to give an accepted order back.
 * Allow: the order is offered to all delivery boys again. Refuse: it stays with him.
 */
function appendReleaseRequestPanel(detailBody, order, ctx) {
  const { api, onRefresh } = ctx;
  const rr = order.deliveryReleaseRequest;
  const who = rr.riderName || order.deliveryBoyName || "Delivery boy";
  const box = node("div", "monitor-split-review monitor-release-request");
  box.append(node("h3", "monitor-split-title", "Delivery boy wants to release this order"));
  box.append(
    node(
      "p",
      "monitor-meta",
      `${who} accepted ${order.orderNumber} and asks to give it back.` +
        (rr.reason ? ` Reason: ${rr.reason}` : "")
    )
  );
  const actions = node("div", "monitor-split-actions");
  const send = async (btn, decision, question) => {
    const ok = await confirmNear(btn, question, { confirmLabel: "Confirm", cancelLabel: "Cancel" });
    if (!ok) return;
    btn.disabled = true;
    const res = await api(
      `/v1/delivery-review/${encodeURIComponent(order.orderId)}/release`,
      "POST",
      { requestId: rr.requestId, decision }
    );
    if (!res.ok) {
      alert(res.json?.error || "Could not save.");
      btn.disabled = false;
      return;
    }
    await onRefresh();
  };
  const allow = node("button", "btn primary", "Allow release");
  allow.type = "button";
  allow.addEventListener("click", () =>
    send(allow, "ALLOW", `Release ${order.orderNumber} from ${who}? It will show as a new order to all delivery boys.`)
  );
  const refuse = node("button", "btn ghost", "Refuse");
  refuse.type = "button";
  refuse.addEventListener("click", () =>
    send(refuse, "REFUSE", `Refuse? ${order.orderNumber} stays with ${who}.`)
  );
  actions.append(allow, refuse);
  box.append(actions);
  detailBody.append(box);
}

/**
 * Rider "multiple payment": the cashier confirms the part paid at the shop,
 * approves or rejects the credit part; the cash part stays with the rider until
 * Cash handover / Rider settlement.
 */
function appendSplitReviewPanel(detailBody, order, ctx) {
  const { api, onRefresh } = ctx;
  const r = order.deliverySplitReview;
  const money = (cents) => moneyLabel(order, cents);
  const box = node("div", "monitor-split-review");
  const who = order.deliveryBoyName || "Delivery boy";
  const title =
    r.kind === "SHOP_PAID"
      ? "Delivery boy says: paid at shop"
      : r.kind === "CREDIT"
        ? "Delivery boy asks: customer credit"
        : "Multiple payment from delivery boy";
  box.append(node("h3", "monitor-split-title", title));
  box.append(
    node(
      "p",
      "monitor-meta",
      r.kind === "MULTI"
        ? `${who} reported: cash ${money(r.cash.requiredCents)} · shop paid ${money(
            r.shopPaid.requiredCents
          )} · credit ${money(r.credit.requiredCents)} (total ${money(r.totalCents)})`
        : `${who} reported the whole bill (${money(r.totalCents)}) as ${
            r.kind === "SHOP_PAID" ? "paid at the shop. Confirm only if the shop really received it." : "credit. Approve only if this customer may pay later."
          }`
    )
  );
  const submission = (tag) =>
    `split-${tag}-${order.orderId}-v${r.reportVersion}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 78);
  const post = async (btn, body) => {
    btn.disabled = true;
    const res = await api(
      `/v1/delivery-review/${encodeURIComponent(order.orderId)}/split`,
      "POST",
      { reportVersion: r.reportVersion, ...body }
    );
    if (!res.ok) {
      alert(res.json?.error || "Could not save.");
      btn.disabled = false;
      return;
    }
    await onRefresh();
  };
  const row = (label, amount, stateText, stateClass) => {
    const el = node("div", "monitor-split-row");
    const left = node("div", "monitor-split-part");
    left.append(node("strong", "", label), node("span", "monitor-split-amount", money(amount)));
    el.append(left, node("span", `monitor-split-state ${stateClass}`, stateText));
    box.append(el);
    return el;
  };

  // Cash: rider's account.
  if (r.cash.state !== "NONE") {
    row(
      "Cash (delivery boy)",
      r.cash.requiredCents,
      r.cash.state === "HANDED_OVER" ? "Handed over ✓" : "With delivery boy — take it in Cash handover",
      r.cash.state === "HANDED_OVER" ? "is-done" : "is-wait"
    );
  }

  // Shop paid: cashier confirms (cash or bank) unless already recorded.
  if (r.shopPaid.state !== "NONE") {
    const el = row(
      "Paid at shop",
      r.shopPaid.requiredCents,
      r.shopPaid.state === "CONFIRMED" ? "Confirmed ✓" : `To confirm: ${money(r.shopPaid.dueCents)}`,
      r.shopPaid.state === "CONFIRMED" ? "is-done" : "is-todo"
    );
    if (r.shopPaid.state === "PENDING") {
      const actions = node("div", "monitor-split-actions");
      const cash = node("button", "btn primary", "Confirm · Cash");
      cash.type = "button";
      cash.addEventListener("click", async () => {
        const ok = await confirmNear(cash, `Record ${money(r.shopPaid.dueCents)} paid in cash at the shop for ${order.orderNumber}?`, {
          confirmLabel: "Confirm",
          cancelLabel: "Cancel",
        });
        if (ok) await post(cash, { action: "CONFIRM_SHOP_PAID", tender: "CASH", submissionId: submission("shopcash") });
      });
      const bankSel = node("select", "monitor-split-bank");
      bankSel.append(new Option("Bank account…", ""));
      const bank = node("button", "btn ghost", "Confirm · Bank");
      bank.type = "button";
      bank.disabled = true;
      bankSel.addEventListener("change", () => {
        bank.disabled = !bankSel.value;
      });
      api("/v1/bank-accounts", "GET").then((res) => {
        for (const a of res.ok ? res.json?.accounts || [] : []) {
          if (a.accountType === "OPERATIONAL" && a.isActive) {
            bankSel.append(new Option(`${a.displayName} · ${a.bankName}`, a.accountId));
          }
        }
      });
      bank.addEventListener("click", async () => {
        if (!bankSel.value) return;
        const ok = await confirmNear(bank, `Record ${money(r.shopPaid.dueCents)} paid by bank for ${order.orderNumber}?`, {
          confirmLabel: "Confirm",
          cancelLabel: "Cancel",
        });
        if (ok) {
          await post(bank, {
            action: "CONFIRM_SHOP_PAID",
            tender: "BANK",
            bankAccountId: bankSel.value,
            submissionId: submission("shopbank"),
          });
        }
      });
      actions.append(cash, bankSel, bank);
      el.after(actions);
    }
  }

  // Credit: shop approves (customer pays later) or rejects (rider must correct).
  if (r.credit.state !== "NONE") {
    const text =
      r.credit.state === "APPROVED"
        ? "Approved ✓"
        : r.credit.state === "REJECTED"
          ? `Rejected — waiting for delivery boy${r.credit.rejectNote ? ` (${r.credit.rejectNote})` : ""}`
          : "Needs approval";
    const el = row(
      "Credit (customer pays later)",
      r.credit.requiredCents,
      text,
      r.credit.state === "APPROVED" ? "is-done" : r.credit.state === "REJECTED" ? "is-bad" : "is-todo"
    );
    if (r.credit.state === "PENDING" || r.credit.state === "REJECTED") {
      const actions = node("div", "monitor-split-actions");
      const approve = node("button", "btn primary", "Approve credit");
      approve.type = "button";
      approve.addEventListener("click", async () => {
        const who = order.customerName ? ` to ${order.customerName}` : "";
        const ok = await confirmNear(approve, `Give ${money(r.credit.dueCents)} credit${who} for ${order.orderNumber}?`, {
          confirmLabel: "Approve",
          cancelLabel: "Cancel",
        });
        if (ok) await post(approve, { action: "APPROVE_CREDIT", submissionId: submission("credit") });
      });
      actions.append(approve);
      if (r.credit.state === "PENDING") {
        const reject = node("button", "btn ghost danger", "Reject credit");
        reject.type = "button";
        reject.addEventListener("click", async () => {
          const note = prompt(`Why is credit refused for ${order.orderNumber}? (the delivery boy sees this)`);
          if (note === null) return;
          if (note.trim().length < 3) {
            alert("Enter a short reason (at least 3 characters).");
            return;
          }
          await post(reject, { action: "REJECT_CREDIT", note: note.trim() });
        });
        actions.append(reject);
      }
      el.after(actions);
    }
    if (!r.hasOrderCustomer && r.credit.state !== "APPROVED") {
      box.append(node("p", "monitor-meta", "Add the customer to this order before approving credit."));
    }
  }
  box.append(
    node(
      "p",
      `monitor-split-summary ${r.complete ? "is-done" : ""}`,
      r.complete
        ? r.kind === "MULTI" ? "All parts settled ✓" : "Settled ✓"
        : r.shopActionsDone
          ? "Shop part done — cash still with delivery boy"
          : "Waiting for shop review"
    )
  );
  detailBody.append(box);
}

function appendDetailBody(detailBody, order, ctx) {
  const { session, api, onRefresh } = ctx;
  const prep = order.preparation || {};
  const dispatch = order.dispatch || {};
  const life = order.deliveryLifecycle || {};
  const riderPay = order.deliveryPaymentReport || {};
  const stations = node("ul", "monitor-station-list");
  for (const station of prep.stations || []) {
    stations.append(node("li", "", `${station.stationName}: ${station.status}`));
  }
  if (prep.unassignedLineCount) {
    const n = Number(prep.unassignedLineCount);
    stations.append(
      node(
        "li",
        "",
        n === 1
          ? "1 item not assigned to a kitchen station"
          : `${n} items not assigned to a kitchen station`
      )
    );
  }
  if (stations.childElementCount) detailBody.append(stations);
  if (dispatch.status)
    detailBody.append(node("p", "monitor-meta", `Dispatch: ${titleCase(dispatch.status)}`));
  if (riderPay.status && order.deliveryBoyName) {
    detailBody.append(
      node("p", "monitor-meta", `Rider payment: ${titleCase(riderPay.status)}`)
    );
  }
  if (
    order.fulfillmentBehavior !== "DELIVERY" ||
    !(session.permissions || []).includes("sales.orders.view") ||
    !["admin", "cashier"].includes(session.role)
  ) {
    return;
  }
  if (order.deliveryReleaseRequest) appendReleaseRequestPanel(detailBody, order, ctx);
  if (life.status === "CANCEL_REQUESTED" && life.reason) {
    detailBody.append(node("p", "monitor-meta", `Cancellation reason: ${life.reason}`));
  }
  if (life.status === "CANCEL_REQUESTED") {
    const actions = node("div", "monitor-review-actions");
    for (const [action, caption] of [
      ["APPROVE_CANCEL", "Approve delivery cancellation"],
      ["REJECT_CANCEL", "Reject cancellation request"],
    ]) {
      const btn = node("button", "btn ghost", caption);
      btn.type = "button";
      btn.addEventListener("click", async () => {
        const ok = await confirmNear(
          btn,
          `${caption} for ${order.orderNumber}? Invoice is NOT voided/refunded.`,
          { confirmLabel: "Confirm", cancelLabel: "Cancel" }
        );
        if (!ok) return;
        btn.disabled = true;
        const res = await api(
          `/v1/delivery-review/${encodeURIComponent(order.orderId)}/cancellation`,
          "POST",
          { action, expectedVersion: life.version }
        );
        if (!res.ok) alert(res.json.error || "Review failed.");
        await onRefresh();
      });
      actions.append(btn);
    }
    detailBody.append(actions);
  }
  const p = riderPay;
  const reviewPanel = Boolean(order.deliverySplitReview);
  if (reviewPanel) appendSplitReviewPanel(detailBody, order, ctx);
  if (p.status === "SHOP_PAID_REPORTED" && !reviewPanel) {
    const info = node("div", "monitor-review-actions");
    info.append(
      node(
        "p",
        "monitor-meta",
        "Delivery Boy reports paid at shop. Verify against actual cashier settlement; do not approve a second payment."
      )
    );
    const link = node("a", "btn ghost", "Open Orders to record/check payment");
    link.href = "/orders.html?view=list";
    info.append(link);
    detailBody.append(info);
  }
  const alreadyShopApproved =
    p.shopAuthorized || order.shopCreditAuthorization?.state === "APPROVED";
  if (alreadyShopApproved) {
    const info = node("div", "monitor-review-actions");
    info.append(
      node(
        "p",
        "monitor-meta",
        `Customer Credit approved by ${p.reviewedBy || order.shopCreditAuthorization?.approved_by || "shop"} — visible to Delivery Boy. Receivable ledger posting pending.`
      )
    );
    const revoke = node("button", "btn ghost", "Revoke shop credit authorization");
    revoke.type = "button";
    revoke.addEventListener("click", async () => {
      const note = prompt(`Reason to revoke credit authorization for ${order.orderNumber}?`);
      if (note === null) return;
      if (note.trim().length < 3) {
        alert("Enter a reason (at least 3 characters).");
        return;
      }
      if (
        !confirm(
          `Revoke shop credit authorization for ${order.orderNumber}? No finance entry is reversed.`
        )
      )
        return;
      revoke.disabled = true;
      const res = await api(
        `/v1/delivery-review/${encodeURIComponent(order.orderId)}/shop-credit`,
        "POST",
        {
          action: "REVOKE",
          expectedVersion: Number(
            order.shopCreditAuthorization?.version || p.shopCreditVersion || 0
          ),
          note: note.trim(),
        }
      );
      if (!res.ok) alert(res.json.error || "Could not revoke.");
      await onRefresh();
    });
    info.append(revoke);
    detailBody.append(info);
  } else if (
    !reviewPanel &&
    order.paymentStatus !== "PAID" &&
    !["CANCELLED", "CANCEL_REQUESTED"].includes(life.status)
  ) {
    const link = node("a", "btn ghost", "Open Orders · Cash / Bank / Credit");
    link.href = "/orders.html?view=list";
    detailBody.append(link);
  }
  if (p.status === "CREDIT_REPORTED" && !reviewPanel) {
    const info = node("div", "monitor-review-actions");
    info.append(
      node(
        "p",
        "monitor-meta",
        "Rider requests customer credit. Check with the shop, then record the correct Cash / Bank / Credit allocation in Orders. No separate credit approval is required."
      )
    );
    const link = node("a", "btn ghost", "Open Orders · Record verified payment");
    link.href = "/orders.html?view=list";
    info.append(link);
    detailBody.append(info);
  }
}

/**
 * @param {object} order
 * @param {{ session: object, expandedOrderIds: Set, api: Function, onRefresh: Function }} ctx
 */
export function renderOrderCard(order, ctx) {
  if (orderTypeKey(order) === "DELIVERY") return renderDeliveryCard(order, ctx);

  const article = node("article", "monitor-order monitor-order--compact");
  const prep = order.preparation || {};
  const prepRaw = prep.stage || "NEW";
  const processing = ["PREPARING", "ACCEPTED"].includes(prepRaw);
  const life = order.deliveryLifecycle || {};
  const riderPay = order.deliveryPaymentReport || {};

  const row1 = node("div", "monitor-card-row monitor-card-head");
  const identity = node("div", "monitor-card-identity");
  identity.append(node("h2", "monitor-number", order.orderNumber || "Order"));
  if (
    Number.isFinite(Number(order.tokenNumber)) &&
    order.tokenNumber != null &&
    String(order.tokenNumber) !== ""
  ) {
    identity.append(
      node("span", "monitor-token", `TOKEN ${String(order.tokenNumber).padStart(3, "0")}`)
    );
  }
  row1.append(identity);
  row1.append(
    node(
      "span",
      "monitor-type",
      titleCase(order.fulfillmentBehavior || order.orderTypeName || "ORDER")
    )
  );
  article.append(row1);

  const customer = String(order.customerName || "").trim();
  const address = shortAddress(order);
  if (customer || address) {
    const row2 = node("div", "monitor-card-row monitor-card-meta");
    row2.append(
      node("span", "monitor-customer-line", [customer, address].filter(Boolean).join(" · "))
    );
    article.append(row2);
  }

  const row3 = node("div", "monitor-card-row monitor-card-money");
  row3.append(node("strong", "monitor-total", formatApiTotal(order)));
  const credit =
    order.shopCreditAuthorization?.state === "APPROVED" || riderPay.shopAuthorized;
  const payment = String(order.paymentStatus || "UNPAID").toUpperCase();
  if (order.fulfillmentStatus === "VOID") row3.append(smallBadge("VOID", "is-danger"));
  else if (payment === "PAID") row3.append(smallBadge("PAID", "is-success"));
  else if (credit || payment === "CREDIT") row3.append(smallBadge("CREDIT", "is-credit"));
  else if (payment === "PARTIAL") row3.append(smallBadge("PARTIAL", "is-progress"));
  else row3.append(smallBadge("UNPAID", "is-neutral"));
  if (processing && order.fulfillmentStatus !== "VOID") {
    row3.append(smallBadge("PROCESSING", "is-progress"));
  }
  if (life.status === "CANCEL_REQUESTED") {
    row3.append(smallBadge("CANCEL REQUESTED", "is-danger"));
  } else if (life.status === "CANCELLED") {
    row3.append(smallBadge("CANCELLED", "is-danger"));
  }
  const ago = timeAgo(order.createdAt);
  if (ago) row3.append(node("span", "monitor-ago", ago));
  article.append(row3);

  appendActionsRow(article, order, ctx);
  return article;
}

function laneHeading(label, count) {
  const h = node("h3", "monitor-lane-heading");
  h.append(document.createTextNode(`${label} `));
  const badge = node("span", "monitor-lane-count", String(count));
  badge.setAttribute("aria-label", `${count} orders`);
  h.append(badge);
  return h;
}

/** Stable board signature so silent polls do not rebuild the DOM (avoids blink). */
export function boardFingerprint(orders) {
  try {
    return JSON.stringify(
      (orders || []).map((o) => [
        o.orderId || o.order_id || "",
        o.status || "",
        o.tokenNumber ?? o.token_number ?? "",
        o.paymentStatus || o.payment_status || "",
        o.dispatch?.ready ?? o.readyForDelivery ?? false,
        o.deliveryLifecycle?.status || "",
        o.releaseRequest?.status || "",
        o.releaseRequest?.requestId || "",
        o.updatedAt || o.updated_at || "",
        Number(o.totalCents ?? o.total_cents ?? 0),
        o.driverUserId || o.driver_user_id || "",
      ])
    );
  } catch {
    return String(Date.now());
  }
}

/**
 * @param {HTMLElement} host
 * @param {object[]} orders
 * @param {{ session: object, expandedOrderIds: Set, api: Function, onRefresh: Function }} ctx
 */
export function renderBoard(host, orders, ctx) {
  const sortMode = ctx?.sortMode === "block-road" ? "block-road" : "token";
  const nextFp = `${boardFingerprint(orders)}|${sortMode}`;
  if (host.dataset.boardFp === nextFp && host.childElementCount > 0) {
    return false;
  }
  host.dataset.boardFp = nextFp;
  host.replaceChildren();
  const byType = new Map();
  for (const order of orders || []) {
    const type = orderTypeKey(order);
    if (!byType.has(type)) {
      byType.set(type, { ready: [], pending: [], out: [], delivered: [] });
    }
    byType.get(type)[boardLane(order)].push(order);
  }
  const types = [...byType.keys()].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a);
    const ib = TYPE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  if (!types.length) {
    host.append(node("p", "monitor-empty", "No orders for this filter."));
    return true;
  }
  for (const type of types) {
    const buckets = byType.get(type);
    const typeCount = LANE_ORDER.reduce((n, lane) => n + buckets[lane.key].length, 0);
    const section = node("section", "monitor-type-section");
    section.append(node("h2", "monitor-type-heading", `${titleCase(type)} · ${typeCount}`));
    // Delivery + block/road sort: use route order inside each lane.
    // All other types (and Delivery by token): token number ascending.
    const laneSort =
      type === "DELIVERY" && sortMode === "block-road" ? "block-road" : "token";
    for (const lane of LANE_ORDER) {
      const rows = buckets[lane.key];
      if (!rows.length) continue;
      const label = type === "DELIVERY" ? lane.deliveryLabel : lane.otherLabel;
      const isDone = lane.key === "delivered";
      const laneEl = node(
        "div",
        `monitor-lane monitor-lane-${lane.key}${isDone ? " monitor-lane--done" : ""}`
      );
      if (isDone) {
        const wrap = node("details", "monitor-lane-collapse");
        const sum = node("summary", "monitor-lane-collapse-summary");
        sum.textContent = `${label} (${rows.length}) – Show`;
        wrap.append(sum);
        const grid = node("div", "monitor-lane-grid");
        appendSortedCards(grid, rows, ctx, laneSort);
        wrap.append(grid);
        laneEl.append(wrap);
      } else {
        laneEl.append(laneHeading(label, rows.length));
        const grid = node("div", "monitor-lane-grid");
        appendSortedCards(grid, rows, ctx, laneSort);
        laneEl.append(grid);
      }
      section.append(laneEl);
    }
    host.append(section);
  }
  return true;
}
