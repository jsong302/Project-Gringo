/**
 * Content Queue — pre-generated daily lessons & lunfardo posts.
 *
 * Two separate queues (lesson_queue and lunfardo_queue) store
 * pre-generated content. Cron jobs pull the next ready item
 * instead of generating on-the-fly. Admins can view, edit,
 * reorder, remove, or add items via admin tools.
 *
 * Status flow: ready → sent → archived
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import {
  generateDailyLesson,
  generateLunfardoPost,
  formatDailyLessonBlocks,
  formatLunfardoBlocks,
  getRecentLessonTopics,
  type DailyLesson,
  type LunfardoPost,
} from './lessonEngine';
import { getAllUsers } from './userService';

const queueLog = log.withScope('content-queue');

// ── Types ───────────────────────────────────────────────────

export interface LessonQueueItem {
  id: number;
  scheduledDate: string;
  sortOrder: number;
  status: 'ready' | 'sent' | 'archived';
  title: string | null;
  contentJson: string;
  blocksJson: string | null;
  difficulty: number | null;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LunfardoQueueItem {
  id: number;
  scheduledDate: string;
  sortOrder: number;
  status: 'ready' | 'sent' | 'archived';
  word: string | null;
  contentJson: string;
  blocksJson: string | null;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Unified type for admin tools that work across both queues
export type QueueItem = (LessonQueueItem & { contentType: 'daily_lesson'; title: string | null })
  | (LunfardoQueueItem & { contentType: 'lunfardo'; title: string | null });

// ── Schema bootstrap ────────────────────────────────────────

export function ensureContentQueueTables(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS lesson_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_date TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'archived')),
      title TEXT,
      content_json TEXT NOT NULL,
      blocks_json TEXT,
      difficulty INTEGER,
      slack_channel_id TEXT,
      slack_message_ts TEXT,
      posted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lesson_queue_status ON lesson_queue(status, scheduled_date)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS lunfardo_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_date TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'archived')),
      word TEXT,
      content_json TEXT NOT NULL,
      blocks_json TEXT,
      slack_channel_id TEXT,
      slack_message_ts TEXT,
      posted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lunfardo_queue_status ON lunfardo_queue(status, scheduled_date)`);
}

// ── SQL helpers ─────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

const LESSON_COLS = `id, scheduled_date, sort_order, status, title,
  content_json, blocks_json, difficulty, slack_channel_id, slack_message_ts,
  posted_at, created_at, updated_at`;

const LUNFARDO_COLS = `id, scheduled_date, sort_order, status, word,
  content_json, blocks_json, slack_channel_id, slack_message_ts,
  posted_at, created_at, updated_at`;

function rowToLessonItem(row: unknown[]): LessonQueueItem {
  return {
    id: row[0] as number,
    scheduledDate: row[1] as string,
    sortOrder: row[2] as number,
    status: row[3] as 'ready' | 'sent' | 'archived',
    title: row[4] as string | null,
    contentJson: row[5] as string,
    blocksJson: row[6] as string | null,
    difficulty: row[7] as number | null,
    slackChannelId: row[8] as string | null,
    slackMessageTs: row[9] as string | null,
    postedAt: row[10] as string | null,
    createdAt: row[11] as string,
    updatedAt: row[12] as string,
  };
}

function rowToLunfardoItem(row: unknown[]): LunfardoQueueItem {
  return {
    id: row[0] as number,
    scheduledDate: row[1] as string,
    sortOrder: row[2] as number,
    status: row[3] as 'ready' | 'sent' | 'archived',
    word: row[4] as string | null,
    contentJson: row[5] as string,
    blocksJson: row[6] as string | null,
    slackChannelId: row[7] as string | null,
    slackMessageTs: row[8] as string | null,
    postedAt: row[9] as string | null,
    createdAt: row[10] as string,
    updatedAt: row[11] as string,
  };
}

// ── Lesson Queue operations ─────────────────────────────────

export function getLessonQueueItems(opts: {
  status?: string;
  limit?: number;
} = {}): LessonQueueItem[] {
  const db = getDb();
  const conditions: string[] = [];
  if (opts.status) conditions.push(`status = '${opts.status}'`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;

  const result = db.exec(
    `SELECT ${LESSON_COLS} FROM lesson_queue ${where}
     ORDER BY scheduled_date ASC, sort_order ASC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToLessonItem);
}

export function getLessonQueueItem(id: number): LessonQueueItem | null {
  const db = getDb();
  const result = db.exec(`SELECT ${LESSON_COLS} FROM lesson_queue WHERE id = ${id}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToLessonItem(result[0].values[0]);
}

export function getNextReadyLesson(): LessonQueueItem | null {
  const db = getDb();
  const result = db.exec(
    `SELECT ${LESSON_COLS} FROM lesson_queue
     WHERE status = 'ready' AND scheduled_date <= date('now')
     ORDER BY scheduled_date ASC, sort_order ASC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToLessonItem(result[0].values[0]);
}

export function insertLessonQueueItem(item: {
  scheduledDate: string;
  title: string;
  contentJson: string;
  blocksJson: string;
  difficulty?: number;
}): number {
  const db = getDb();
  const difficulty = item.difficulty ?? 'NULL';
  db.run(
    `INSERT INTO lesson_queue (scheduled_date, title, content_json, blocks_json, difficulty)
     VALUES ('${esc(item.scheduledDate)}', '${esc(item.title)}', '${esc(item.contentJson)}', '${esc(item.blocksJson)}', ${difficulty})`,
  );
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0] as number;
}

export function updateLessonQueueItem(id: number, fields: Partial<{
  title: string;
  contentJson: string;
  blocksJson: string;
  scheduledDate: string;
  sortOrder: number;
  status: string;
  difficulty: number;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  if (fields.title !== undefined) sets.push(`title = '${esc(fields.title)}'`);
  if (fields.contentJson !== undefined) sets.push(`content_json = '${esc(fields.contentJson)}'`);
  if (fields.blocksJson !== undefined) sets.push(`blocks_json = '${esc(fields.blocksJson)}'`);
  if (fields.scheduledDate !== undefined) sets.push(`scheduled_date = '${esc(fields.scheduledDate)}'`);
  if (fields.sortOrder !== undefined) sets.push(`sort_order = ${fields.sortOrder}`);
  if (fields.status !== undefined) sets.push(`status = '${esc(fields.status)}'`);
  if (fields.difficulty !== undefined) sets.push(`difficulty = ${fields.difficulty}`);
  sets.push(`updated_at = datetime('now')`);
  if (sets.length === 1) return;
  db.run(`UPDATE lesson_queue SET ${sets.join(', ')} WHERE id = ${id}`);
}

export function markLessonAsSent(id: number, channelId: string, messageTs: string): void {
  const db = getDb();
  db.run(
    `UPDATE lesson_queue SET status = 'sent', slack_channel_id = '${esc(channelId)}',
     slack_message_ts = '${esc(messageTs)}', posted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ${id}`,
  );
}

export function archiveLessonQueueItem(id: number): void {
  const db = getDb();
  db.run(`UPDATE lesson_queue SET status = 'archived', updated_at = datetime('now') WHERE id = ${id}`);
}

export function deleteLessonQueueItem(id: number): void {
  const db = getDb();
  db.run(`DELETE FROM lesson_queue WHERE id = ${id}`);
}

// ── Lunfardo Queue operations ───────────────────────────────

export function getLunfardoQueueItems(opts: {
  status?: string;
  limit?: number;
} = {}): LunfardoQueueItem[] {
  const db = getDb();
  const conditions: string[] = [];
  if (opts.status) conditions.push(`status = '${opts.status}'`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;

  const result = db.exec(
    `SELECT ${LUNFARDO_COLS} FROM lunfardo_queue ${where}
     ORDER BY scheduled_date ASC, sort_order ASC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToLunfardoItem);
}

export function getLunfardoQueueItem(id: number): LunfardoQueueItem | null {
  const db = getDb();
  const result = db.exec(`SELECT ${LUNFARDO_COLS} FROM lunfardo_queue WHERE id = ${id}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToLunfardoItem(result[0].values[0]);
}

export function getNextReadyLunfardo(): LunfardoQueueItem | null {
  const db = getDb();
  const result = db.exec(
    `SELECT ${LUNFARDO_COLS} FROM lunfardo_queue
     WHERE status = 'ready' AND scheduled_date <= date('now')
     ORDER BY scheduled_date ASC, sort_order ASC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToLunfardoItem(result[0].values[0]);
}

export function insertLunfardoQueueItem(item: {
  scheduledDate: string;
  word: string;
  contentJson: string;
  blocksJson: string;
}): number {
  const db = getDb();
  db.run(
    `INSERT INTO lunfardo_queue (scheduled_date, word, content_json, blocks_json)
     VALUES ('${esc(item.scheduledDate)}', '${esc(item.word)}', '${esc(item.contentJson)}', '${esc(item.blocksJson)}')`,
  );
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0] as number;
}

export function updateLunfardoQueueItem(id: number, fields: Partial<{
  word: string;
  contentJson: string;
  blocksJson: string;
  scheduledDate: string;
  sortOrder: number;
  status: string;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  if (fields.word !== undefined) sets.push(`word = '${esc(fields.word)}'`);
  if (fields.contentJson !== undefined) sets.push(`content_json = '${esc(fields.contentJson)}'`);
  if (fields.blocksJson !== undefined) sets.push(`blocks_json = '${esc(fields.blocksJson)}'`);
  if (fields.scheduledDate !== undefined) sets.push(`scheduled_date = '${esc(fields.scheduledDate)}'`);
  if (fields.sortOrder !== undefined) sets.push(`sort_order = ${fields.sortOrder}`);
  if (fields.status !== undefined) sets.push(`status = '${esc(fields.status)}'`);
  sets.push(`updated_at = datetime('now')`);
  if (sets.length === 1) return;
  db.run(`UPDATE lunfardo_queue SET ${sets.join(', ')} WHERE id = ${id}`);
}

export function markLunfardoAsSent(id: number, channelId: string, messageTs: string): void {
  const db = getDb();
  db.run(
    `UPDATE lunfardo_queue SET status = 'sent', slack_channel_id = '${esc(channelId)}',
     slack_message_ts = '${esc(messageTs)}', posted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ${id}`,
  );
}

export function archiveLunfardoQueueItem(id: number): void {
  const db = getDb();
  db.run(`UPDATE lunfardo_queue SET status = 'archived', updated_at = datetime('now') WHERE id = ${id}`);
}

export function deleteLunfardoQueueItem(id: number): void {
  const db = getDb();
  db.run(`DELETE FROM lunfardo_queue WHERE id = ${id}`);
}

// ── Stats (both queues) ─────────────────────────────────────

function countByStatus(table: string): { ready: number; sent: number } {
  const db = getDb();
  const result = db.exec(
    `SELECT status, COUNT(*) FROM ${table} WHERE status IN ('ready', 'sent') GROUP BY status`,
  );
  const counts = { ready: 0, sent: 0 };
  if (result.length) {
    for (const row of result[0].values) {
      counts[row[0] as 'ready' | 'sent'] = row[1] as number;
    }
  }
  return counts;
}

function nextReadyDate(table: string): string | null {
  const db = getDb();
  const result = db.exec(
    `SELECT scheduled_date FROM ${table} WHERE status = 'ready' ORDER BY scheduled_date ASC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return result[0].values[0][0] as string;
}

export function getQueueStats(): {
  lessons: { ready: number; sent: number; nextDate: string | null };
  lunfardo: { ready: number; sent: number; nextDate: string | null };
} {
  return {
    lessons: { ...countByStatus('lesson_queue'), nextDate: nextReadyDate('lesson_queue') },
    lunfardo: { ...countByStatus('lunfardo_queue'), nextDate: nextReadyDate('lunfardo_queue') },
  };
}

// ── Re-render blocks ────────────────────────────────────────

export function rerenderLessonBlocks(contentJson: string): string {
  const content = JSON.parse(contentJson) as DailyLesson;
  return JSON.stringify(formatDailyLessonBlocks(content));
}

export function rerenderLunfardoBlocks(contentJson: string): string {
  const content = JSON.parse(contentJson) as LunfardoPost;
  return JSON.stringify(formatLunfardoBlocks(content));
}

// ── Batch generation ────────────────────────────────────────

let generatingLessons = false;
let generatingLunfardo = false;

export function isQueueGenerationRunning(): boolean {
  return generatingLessons || generatingLunfardo;
}

export function isLessonGenerationRunning(): boolean {
  return generatingLessons;
}

export function isLunfardoGenerationRunning(): boolean {
  return generatingLunfardo;
}

function getNextWeekdays(startDate: Date, count: number, existingDates: Set<string>): string[] {
  const dates: string[] = [];
  const d = new Date(startDate);
  while (dates.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      const dateStr = d.toISOString().slice(0, 10);
      if (!existingDates.has(dateStr)) dates.push(dateStr);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function getNextDays(startDate: Date, count: number, existingDates: Set<string>): string[] {
  const dates: string[] = [];
  const d = new Date(startDate);
  while (dates.length < count) {
    const dateStr = d.toISOString().slice(0, 10);
    if (!existingDates.has(dateStr)) dates.push(dateStr);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function getExistingDates(table: string): Set<string> {
  const db = getDb();
  const result = db.exec(
    `SELECT DISTINCT scheduled_date FROM ${table} WHERE status IN ('ready', 'sent')`,
  );
  const dates = new Set<string>();
  if (result.length) {
    for (const row of result[0].values) dates.add(row[0] as string);
  }
  return dates;
}

function getQueuedLessonTopics(): string[] {
  const db = getDb();
  const result = db.exec(
    `SELECT title FROM lesson_queue WHERE status IN ('ready', 'sent') ORDER BY scheduled_date DESC LIMIT 20`,
  );
  if (!result.length) return [];
  return result[0].values.map(row => row[0] as string).filter(Boolean);
}

export async function generateLessonQueue(days: number = 10): Promise<{
  generated: number; errors: number; errorDetails?: string[];
}> {
  if (generatingLessons) return { generated: 0, errors: 0 };
  generatingLessons = true;

  try {
    const existingDates = getExistingDates('lesson_queue');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dates = getNextWeekdays(tomorrow, days, existingDates);

    if (dates.length === 0) {
      queueLog.info('No dates need daily lessons — queue is full');
      return { generated: 0, errors: 0 };
    }

    queueLog.info(`Generating lessons for ${dates.length} dates: ${dates.join(', ')}`);

    const postedTopics = getRecentLessonTopics(10);
    const queuedTopics = getQueuedLessonTopics();
    const allRecentTopics = [...new Set([...postedTopics, ...queuedTopics])];

    const users = getAllUsers().filter(u => u.onboarded);
    const avgLevel = users.length > 0
      ? Math.round(users.reduce((sum, u) => sum + u.level, 0) / users.length)
      : 2;

    let generated = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (const date of dates) {
      try {
        const { lesson, blocks } = await generateDailyLesson(avgLevel, allRecentTopics);
        insertLessonQueueItem({
          scheduledDate: date,
          title: lesson.title,
          contentJson: JSON.stringify(lesson),
          blocksJson: JSON.stringify(blocks),
          difficulty: lesson.difficulty,
        });
        allRecentTopics.push(lesson.title);
        generated++;
        queueLog.info(`Queued daily lesson for ${date}: "${lesson.title}"`);
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        errorDetails.push(`${date}: ${msg}`);
        queueLog.error(`Failed to generate lesson for ${date}: ${msg}`);
      }
    }

    queueLog.info(`Lesson queue: ${generated} generated, ${errors} errors`);
    return { generated, errors, errorDetails };
  } finally {
    generatingLessons = false;
  }
}

export async function generateLunfardoQueue(days: number = 14): Promise<{
  generated: number; errors: number; errorDetails?: string[];
}> {
  if (generatingLunfardo) return { generated: 0, errors: 0 };
  generatingLunfardo = true;

  try {
    const existingDates = getExistingDates('lunfardo_queue');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dates = getNextDays(tomorrow, days, existingDates);

    if (dates.length === 0) {
      queueLog.info('No dates need lunfardo posts — queue is full');
      return { generated: 0, errors: 0 };
    }

    queueLog.info(`Generating lunfardo for ${dates.length} dates: ${dates.join(', ')}`);

    let generated = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (const date of dates) {
      try {
        const { post, blocks } = await generateLunfardoPost();
        insertLunfardoQueueItem({
          scheduledDate: date,
          word: post.word,
          contentJson: JSON.stringify(post),
          blocksJson: JSON.stringify(blocks),
        });
        generated++;
        queueLog.info(`Queued lunfardo for ${date}: "${post.word}"`);
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        errorDetails.push(`${date}: ${msg}`);
        queueLog.error(`Failed to generate lunfardo for ${date}: ${msg}`);
      }
    }

    queueLog.info(`Lunfardo queue: ${generated} generated, ${errors} errors`);
    return { generated, errors, errorDetails };
  } finally {
    generatingLunfardo = false;
  }
}

export async function regenerateLessonQueueItem(id: number): Promise<LessonQueueItem | null> {
  const item = getLessonQueueItem(id);
  if (!item) return null;
  const avgLevel = item.difficulty ?? 2;
  const { lesson, blocks } = await generateDailyLesson(avgLevel);
  updateLessonQueueItem(id, {
    title: lesson.title,
    contentJson: JSON.stringify(lesson),
    blocksJson: JSON.stringify(blocks),
    difficulty: lesson.difficulty,
    status: 'ready',
  });
  queueLog.info(`Regenerated lesson queue item ${id}: "${lesson.title}"`);
  return getLessonQueueItem(id);
}

export async function regenerateLunfardoQueueItem(id: number): Promise<LunfardoQueueItem | null> {
  const item = getLunfardoQueueItem(id);
  if (!item) return null;
  const { post, blocks } = await generateLunfardoPost();
  updateLunfardoQueueItem(id, {
    word: post.word,
    contentJson: JSON.stringify(post),
    blocksJson: JSON.stringify(blocks),
    status: 'ready',
  });
  queueLog.info(`Regenerated lunfardo queue item ${id}: "${post.word}"`);
  return getLunfardoQueueItem(id);
}
