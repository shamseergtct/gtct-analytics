/**
 * Gives acceptance callers a stable submission id when they retry by order number.
 * The server still requires the id and does not treat the order number as the key.
 */
export function withSubmissionId(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (!Array.isArray(body.lines) || body.submissionId) return body;
  const raw = String(body.orderNumber || "draft").replace(/[^A-Za-z0-9_-]/g, "");
  let id = `sub-${raw}`;
  if (id.length < 8) id = `${id}-order`;
  if (id.length > 80) id = `sub-${raw.slice(-60)}-${raw.length}`;
  return { ...body, submissionId: id.slice(0, 80) };
}
