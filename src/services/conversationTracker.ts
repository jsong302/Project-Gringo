/**
 * Conversation Tracker — manages multi-turn conversation state.
 *
 * Each Slack thread maps to one conversation_threads record.
 * Supports charla, lesson, review, desafio, shadow, dialogue types.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const convLog = log.withScope('conversation');

// ── Types ───────────────────────────────────────────────────

export type ThreadType = 'charla' | 'lesson' | 'review' | 'desafio' | 'shadow' | 'dialogue';

export interface Conversation {
  id: number;
  userId: number;
  slackChannelId: string;
  slackThreadTs: string;
  threadType: ThreadType;
  scenario: string | null;
  turnCount: number;
  status: 'active' | 'completed' | 'abandoned';
  partnerUserId: number | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── CRUD ────────────────────────────────────────────────────

export function startConversation(
  userId: number,
  channelId: string,
  threadTs: string,
  type: ThreadType,
  scenario?: string,
): Conversation {
  const db = getDb();
  db.run(
    `INSERT INTO conversation_threads (user_id, slack_channel_id, slack_thread_ts, thread_type, scenario)
     VALUES (${userId}, '${esc(channelId)}', '${esc(threadTs)}', '${type}', ${scenario ? `'${esc(scenario)}'` : 'NULL'})`,
  );

  const result = db.exec('SELECT last_insert_rowid()');
  const id = (result[0]?.values[0]?.[0] as number) ?? 0;

  convLog.info(`Started ${type} conversation ${id} for user ${userId}`);
  return getConversationById(id)!;
}

export function getConversationById(id: number): Conversation | null {
  const db = getDb();
  const result = db.exec(`SELECT * FROM conversation_threads WHERE id = ${id}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToConversation(result[0].values[0]);
}

export function getConversationByThread(
  channelId: string,
  threadTs: string,
): Conversation | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM conversation_threads
     WHERE slack_channel_id = '${esc(channelId)}'
       AND slack_thread_ts = '${esc(threadTs)}'
       AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToConversation(result[0].values[0]);
}

export function getActiveConversation(
  userId: number,
  channelId: string,
  type?: ThreadType,
): Conversation | null {
  const db = getDb();
  const typeFilter = type ? ` AND thread_type = '${type}'` : '';
  const result = db.exec(
    `SELECT * FROM conversation_threads
     WHERE user_id = ${userId}
       AND slack_channel_id = '${esc(channelId)}'
       AND status = 'active'${typeFilter}
     ORDER BY created_at DESC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToConversation(result[0].values[0]);
}

export function addTurn(conversationId: number): void {
  const db = getDb();
  db.run(
    `UPDATE conversation_threads
     SET turn_count = turn_count + 1, updated_at = datetime('now')
     WHERE id = ${conversationId}`,
  );
}

export function endConversation(conversationId: number, summary?: string): void {
  const db = getDb();
  db.run(
    `UPDATE conversation_threads
     SET status = 'completed',
         summary = ${summary ? `'${esc(summary)}'` : 'NULL'},
         updated_at = datetime('now')
     WHERE id = ${conversationId}`,
  );
  convLog.info(`Conversation ${conversationId} completed`);
}

export function abandonConversation(conversationId: number): void {
  const db = getDb();
  db.run(
    `UPDATE conversation_threads
     SET status = 'abandoned', updated_at = datetime('now')
     WHERE id = ${conversationId}`,
  );
  convLog.info(`Conversation ${conversationId} abandoned`);
}

export function getUserConversationHistory(
  userId: number,
  type?: ThreadType,
  limit = 10,
): Conversation[] {
  const db = getDb();
  const typeFilter = type ? ` AND thread_type = '${type}'` : '';
  const result = db.exec(
    `SELECT * FROM conversation_threads
     WHERE user_id = ${userId}${typeFilter}
     ORDER BY created_at DESC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToConversation);
}

// ── Message storage ─────────────────────────────────────────

export function saveMessage(
  conversationId: number,
  role: 'user' | 'assistant',
  content: string,
  messageTs?: string,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO conversation_messages (conversation_id, role, content, message_ts)
     VALUES (${conversationId}, '${role}', '${esc(content)}', ${messageTs ? `'${esc(messageTs)}'` : 'NULL'})`,
  );
}

export function getMessages(
  conversationId: number,
  limit = 20,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const db = getDb();
  const result = db.exec(
    `SELECT role, content FROM conversation_messages
     WHERE conversation_id = ${conversationId}
     ORDER BY created_at DESC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  // Reverse to get chronological order (we SELECTed DESC for the LIMIT)
  return result[0].values.reverse().map((row) => ({
    role: row[0] as 'user' | 'assistant',
    content: row[1] as string,
  }));
}

// ── Stale thread cleanup ────────────────────────────────────

/**
 * Close conversations that have been active for longer than maxAgeHours.
 * Returns the number of conversations closed.
 */
export function closeStaleConversations(maxAgeHours = 24): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM conversation_threads
     WHERE status = 'active'
       AND updated_at < datetime('now', '-${maxAgeHours} hours')`,
  );
  const count = (result[0]?.values[0]?.[0] as number) ?? 0;

  if (count > 0) {
    db.run(
      `UPDATE conversation_threads
       SET status = 'completed', updated_at = datetime('now')
       WHERE status = 'active'
         AND updated_at < datetime('now', '-${maxAgeHours} hours')`,
    );
    convLog.info(`Closed ${count} stale conversations (older than ${maxAgeHours}h)`);
  }

  return count;
}

// ── Row mapper ──────────────────────────────────────────────

function rowToConversation(row: unknown[]): Conversation {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    slackChannelId: row[2] as string,
    slackThreadTs: row[3] as string,
    threadType: row[4] as ThreadType,
    scenario: row[5] as string | null,
    turnCount: row[6] as number,
    status: row[7] as Conversation['status'],
    partnerUserId: row[8] as number | null,
    summary: row[9] as string | null,
    createdAt: row[10] as string,
    updatedAt: row[11] as string,
  };
}

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
