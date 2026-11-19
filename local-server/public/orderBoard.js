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

export function compareOrders(a, b) {
  const tokenA = Number(a.tokenNumber);
  const tokenB = Number(b.tokenNumber);
  if (Number.isFinite(tokenA) && Number.isFinite(tokenB) && tokenA !== tokenB) return tokenB - tokenA;
  return String(b.orderNumber || "").localeCompare(String(a.orderNumber || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
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
      if (!window.confirm(`Confirm all items packed for ${order.orderNumber}?`)) return;
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
      if (!window.confirm(`Move ${order.orderNumber} back to Pending?`)) return;
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
        if (!confirm(`${caption} for ${order.orderNumber}? Invoice is NOT voided/refunded.`))
          return;
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
  if (p.status === "SHOP_PAID_REPORTED") {
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
    order.paymentStatus !== "PAID" &&
    !["CANCELLED", "CANCEL_REQUESTED"].includes(life.status)
  ) {
    const link = node("a", "btn ghost", "Open Orders · Cash / Bank / Credit");
    link.href = "/orders.html?view=list";
    detailBody.append(link);
  }
  if (p.status === "CREDIT_REPORTED") {
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

/**
 * @param {HTMLElement} host
 * @param {object[]} orders
 * @param {{ session: object, expandedOrderIds: Set, api: Function, onRefresh: Function }} ctx
 */
export function renderBoard(host, orders, ctx) {
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
    return;
  }
  for (const type of types) {
    const buckets = byType.get(type);
    const typeCount = LANE_ORDER.reduce((n, lane) => n + buckets[lane.key].length, 0);
    const section = node("section", "monitor-type-section");
    section.append(node("h2", "monitor-type-heading", `${titleCase(type)} · ${typeCount}`));
    for (const lane of LANE_ORDER) {
      const rows = buckets[lane.key].sort(compareOrders);
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
        for (const order of rows) grid.append(renderOrderCard(order, ctx));
        wrap.append(grid);
        laneEl.append(wrap);
      } else {
        laneEl.append(laneHeading(label, rows.length));
        const grid = node("div", "monitor-lane-grid");
        for (const order of rows) grid.append(renderOrderCard(order, ctx));
        laneEl.append(grid);
      }
      section.append(laneEl);
    }
    host.append(section);
  }
}
