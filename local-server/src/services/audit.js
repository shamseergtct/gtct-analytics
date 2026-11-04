import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { log } from "../util/logger.js";

export function recordAudit({
  actorRole = "",
  actorUserId = "",
  action,
  entityType,
  entityId = "",
  detail = {},
}) {
  const db = getDb();
  const eventId = newId("aud");
  const createdAt = nowIso();
  const detailJson = JSON.stringify(detail || {});
  db.prepare(
    `INSERT INTO audit_events (
      event_id, actor_role, actor_user_id, action, entity_type, entity_id, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    actorRole,
    actorUserId || "",
    action,
    entityType,
    entityId,
    detailJson,
    createdAt
  );
  log.info("audit", {
    eventId,
    actorRole,
    action,
    entityType,
    entityId,
    detail,
  });
  return { eventId, createdAt };
}

export function listAuditEvents({ limit = 100, entityType } = {}) {
  const db = getDb();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (entityType) {
    return db
      .prepare(
        `SELECT * FROM audit_events
         WHERE entity_type = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(entityType, lim);
  }
  return db
    .prepare(
      `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`
    )
    .all(lim);
}
