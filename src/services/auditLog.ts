/**
 * Audit Log — Tracks all admin tool invocations with before/after snapshots.
 *
 * Every mutating admin action is logged so admins can review history
 * and revert changes if needed.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const auditLog = log.withScope('audit');

// ── Types ────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  adminSlackId: string;
  toolName: string;
  targetType: string;
  targetId: string | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  input: unknown;
  timestamp: string;
}

// ── Schema migration ─────────────────────────────────────────

export function ensureAuditTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_slack_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_snapshot TEXT,
      after_snapshot TEXT,
      input_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON admin_audit_log(admin_slack_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON admin_audit_log(tool_name, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_target ON admin_audit_log(target_type, target_id)`);
}

// ── Write ────────────────────────────────────────────────────

export function logAuditEntry(
  adminSlackId: string,
  toolName: string,
  targetType: string,
  targetId: string | number | null,
  beforeSnapshot: unknown,
  afterSnapshot: unknown,
  input?: unknown,
): void {
  const db = getDb();
  try {
    db.run(
      `INSERT INTO admin_audit_log (admin_slack_id, tool_name, target_type, target_id, before_snapshot, after_snapshot, input_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        adminSlackId,
        toolName,
        targetType,
        targetId != null ? String(targetId) : null,
        beforeSnapshot != null ? JSON.stringify(beforeSnapshot) : null,
        afterSnapshot != null ? JSON.stringify(afterSnapshot) : null,
        input != null ? JSON.stringify(input) : null,
      ],
    );
    auditLog.debug(`Logged: ${toolName} on ${targetType}:${targetId} by ${adminSlackId}`);
  } catch (err) {
    auditLog.error(`Failed to log audit entry: ${err}`);
  }
}

// ── Read ─────────────────────────────────────────────────────

export function getAuditLog(options?: {
  limit?: number;
  toolName?: string;
  targetType?: string;
  targetId?: string;
  adminSlackId?: string;
}): AuditEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.toolName) {
    conditions.push('tool_name = ?');
    params.push(options.toolName);
  }
  if (options?.targetType) {
    conditions.push('target_type = ?');
    params.push(options.targetType);
  }
  if (options?.targetId) {
    conditions.push('target_id = ?');
    params.push(options.targetId);
  }
  if (options?.adminSlackId) {
    conditions.push('admin_slack_id = ?');
    params.push(options.adminSlackId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit ?? 50;

  const result = db.exec(
    `SELECT id, admin_slack_id, tool_name, target_type, target_id,
            before_snapshot, after_snapshot, input_json, created_at
     FROM admin_audit_log
     ${where}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    params,
  );

  if (!result.length) return [];

  return result[0].values.map((row) => ({
    id: row[0] as number,
    adminSlackId: row[1] as string,
    toolName: row[2] as string,
    targetType: row[3] as string,
    targetId: row[4] as string | null,
    beforeSnapshot: row[5] ? JSON.parse(row[5] as string) : null,
    afterSnapshot: row[6] ? JSON.parse(row[6] as string) : null,
    input: row[7] ? JSON.parse(row[7] as string) : null,
    timestamp: row[8] as string,
  }));
}

/**
 * Get a specific audit entry by ID (for revert operations).
 */
export function getAuditEntry(id: number): AuditEntry | null {
  const entries = getAuditLog({ limit: 1 });
  const db = getDb();
  const result = db.exec(
    `SELECT id, admin_slack_id, tool_name, target_type, target_id,
            before_snapshot, after_snapshot, input_json, created_at
     FROM admin_audit_log WHERE id = ?`,
    [id],
  );
  if (!result.length || !result[0].values.length) return null;
  const row = result[0].values[0];
  return {
    id: row[0] as number,
    adminSlackId: row[1] as string,
    toolName: row[2] as string,
    targetType: row[3] as string,
    targetId: row[4] as string | null,
    beforeSnapshot: row[5] ? JSON.parse(row[5] as string) : null,
    afterSnapshot: row[6] ? JSON.parse(row[6] as string) : null,
    input: row[7] ? JSON.parse(row[7] as string) : null,
    timestamp: row[8] as string,
  };
}
