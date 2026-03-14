/**
 * Content Queue — pre-generated daily lessons & lunfardo posts.
 *
 * Content is generated ahead of time and stored in a queue.
 * Cron jobs pull the next ready item instead of generating on-the-fly.
 * Admins can view, edit, reorder, remove, or add items via admin tools.
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

export interface QueueItem {
  id: number;
  contentType: 'daily_lesson' | 'lunfardo';
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

// ── Schema bootstrap ────────────────────────────────────────

export function ensureContentQueueTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS content_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL CHECK (content_type IN ('daily_lesson', 'lunfardo')),
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_content_queue_type_status ON content_queue(content_type, status, scheduled_date)`);
}

// ── SQL helpers ─────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function rowToItem(row: unknown[]): QueueItem {
  return {
    id: row[0] as number,
    contentType: row[1] as 'daily_lesson' | 'lunfardo',
    scheduledDate: row[2] as string,
    sortOrder: row[3] as number,
    status: row[4] as 'ready' | 'sent' | 'archived',
    title: row[5] as string | null,
    contentJson: row[6] as string,
    blocksJson: row[7] as string | null,
    difficulty: row[8] as number | null,
    slackChannelId: row[9] as string | null,
    slackMessageTs: row[10] as string | null,
    postedAt: row[11] as string | null,
    createdAt: row[12] as string,
    updatedAt: row[13] as string,
  };
}

const SELECT_COLS = `id, content_type, scheduled_date, sort_order, status, title,
  content_json, blocks_json, difficulty, slack_channel_id, slack_message_ts,
  posted_at, created_at, updated_at`;

// ── Read operations ─────────────────────────────────────────

export function getQueueItems(opts: {
  contentType?: 'daily_lesson' | 'lunfardo';
  status?: string;
  limit?: number;
  offset?: number;
} = {}): QueueItem[] {
  const db = getDb();
  const conditions: string[] = [];
  if (opts.contentType) conditions.push(`content_type = '${opts.contentType}'`);
  if (opts.status) conditions.push(`status = '${opts.status}'`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const result = db.exec(
    `SELECT ${SELECT_COLS} FROM content_queue ${where}
     ORDER BY scheduled_date ASC, sort_order ASC
     LIMIT ${limit} OFFSET ${offset}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToItem);
}

export function getQueueItem(id: number): QueueItem | null {
  const db = getDb();
  const result = db.exec(`SELECT ${SELECT_COLS} FROM content_queue WHERE id = ${id}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToItem(result[0].values[0]);
}

export function getNextReady(contentType: 'daily_lesson' | 'lunfardo'): QueueItem | null {
  const db = getDb();
  const result = db.exec(
    `SELECT ${SELECT_COLS} FROM content_queue
     WHERE content_type = '${contentType}' AND status = 'ready'
       AND scheduled_date <= date('now')
     ORDER BY scheduled_date ASC, sort_order ASC
     LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToItem(result[0].values[0]);
}

export function getQueueStats(): {
  daily_lesson: { ready: number; sent: number };
  lunfardo: { ready: number; sent: number };
  nextLessonDate: string | null;
  nextLunfardoDate: string | null;
} {
  const db = getDb();
  const stats = {
    daily_lesson: { ready: 0, sent: 0 },
    lunfardo: { ready: 0, sent: 0 },
    nextLessonDate: null as string | null,
    nextLunfardoDate: null as string | null,
  };

  const countResult = db.exec(
    `SELECT content_type, status, COUNT(*) FROM content_queue
     WHERE status IN ('ready', 'sent')
     GROUP BY content_type, status`,
  );
  if (countResult.length) {
    for (const row of countResult[0].values) {
      const type = row[0] as 'daily_lesson' | 'lunfardo';
      const status = row[1] as 'ready' | 'sent';
      stats[type][status] = row[2] as number;
    }
  }

  const nextLesson = db.exec(
    `SELECT scheduled_date FROM content_queue
     WHERE content_type = 'daily_lesson' AND status = 'ready'
     ORDER BY scheduled_date ASC LIMIT 1`,
  );
  if (nextLesson.length && nextLesson[0].values.length) {
    stats.nextLessonDate = nextLesson[0].values[0][0] as string;
  }

  const nextLunfardo = db.exec(
    `SELECT scheduled_date FROM content_queue
     WHERE content_type = 'lunfardo' AND status = 'ready'
     ORDER BY scheduled_date ASC LIMIT 1`,
  );
  if (nextLunfardo.length && nextLunfardo[0].values.length) {
    stats.nextLunfardoDate = nextLunfardo[0].values[0][0] as string;
  }

  return stats;
}

// ── Write operations ────────────────────────────────────────

export function insertQueueItem(item: {
  contentType: 'daily_lesson' | 'lunfardo';
  scheduledDate: string;
  title: string;
  contentJson: string;
  blocksJson: string;
  difficulty?: number;
  status?: 'ready' | 'archived';
}): number {
  const db = getDb();
  const status = item.status ?? 'ready';
  const difficulty = item.difficulty ?? 'NULL';

  db.run(
    `INSERT INTO content_queue (content_type, scheduled_date, status, title, content_json, blocks_json, difficulty)
     VALUES ('${item.contentType}', '${esc(item.scheduledDate)}', '${status}',
             '${esc(item.title)}', '${esc(item.contentJson)}', '${esc(item.blocksJson)}', ${difficulty})`,
  );
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0] as number;
}

export function updateQueueItem(id: number, fields: Partial<{
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

  if (sets.length === 1) return; // only updated_at — nothing to update
  db.run(`UPDATE content_queue SET ${sets.join(', ')} WHERE id = ${id}`);
}

export function markAsSent(id: number, channelId: string, messageTs: string): void {
  const db = getDb();
  db.run(
    `UPDATE content_queue
     SET status = 'sent', slack_channel_id = '${esc(channelId)}', slack_message_ts = '${esc(messageTs)}',
         posted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ${id}`,
  );
}

export function archiveQueueItem(id: number): void {
  const db = getDb();
  db.run(`UPDATE content_queue SET status = 'archived', updated_at = datetime('now') WHERE id = ${id}`);
}

export function deleteQueueItem(id: number): void {
  const db = getDb();
  db.run(`DELETE FROM content_queue WHERE id = ${id}`);
}

export function reorderQueueItem(id: number, newDate: string, newSortOrder: number): void {
  const db = getDb();
  db.run(
    `UPDATE content_queue SET scheduled_date = '${esc(newDate)}', sort_order = ${newSortOrder}, updated_at = datetime('now')
     WHERE id = ${id}`,
  );
}

// ── Re-render blocks from content_json ──────────────────────

export function rerenderBlocks(item: QueueItem): string {
  const content = JSON.parse(item.contentJson);
  let blocks: any[];
  if (item.contentType === 'daily_lesson') {
    blocks = formatDailyLessonBlocks(content as DailyLesson);
  } else {
    blocks = formatLunfardoBlocks(content as LunfardoPost);
  }
  return JSON.stringify(blocks);
}

// ── Batch generation ────────────────────────────────────────

let generating = false;

export function isQueueGenerationRunning(): boolean {
  return generating;
}

/**
 * Get weekdays (Mon-Fri) starting from a date, skipping dates that already have queued items.
 */
function getNextWeekdays(startDate: Date, count: number, existingDates: Set<string>): string[] {
  const dates: string[] = [];
  const d = new Date(startDate);
  while (dates.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) { // skip weekends
      const dateStr = d.toISOString().slice(0, 10);
      if (!existingDates.has(dateStr)) {
        dates.push(dateStr);
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Get upcoming dates (all days) starting from a date, skipping dates that already have queued items.
 */
function getNextDays(startDate: Date, count: number, existingDates: Set<string>): string[] {
  const dates: string[] = [];
  const d = new Date(startDate);
  while (dates.length < count) {
    const dateStr = d.toISOString().slice(0, 10);
    if (!existingDates.has(dateStr)) {
      dates.push(dateStr);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Get existing queued dates for a content type (ready or sent).
 */
function getExistingQueueDates(contentType: string): Set<string> {
  const db = getDb();
  const result = db.exec(
    `SELECT DISTINCT scheduled_date FROM content_queue
     WHERE content_type = '${contentType}' AND status IN ('ready', 'sent')`,
  );
  const dates = new Set<string>();
  if (result.length) {
    for (const row of result[0].values) {
      dates.add(row[0] as string);
    }
  }
  return dates;
}

/**
 * Get titles of queued items (for topic dedup during batch generation).
 */
function getQueuedTopics(contentType: string): string[] {
  const db = getDb();
  const result = db.exec(
    `SELECT title FROM content_queue
     WHERE content_type = '${contentType}' AND status IN ('ready', 'sent')
     ORDER BY scheduled_date DESC LIMIT 20`,
  );
  if (!result.length) return [];
  return result[0].values.map(row => row[0] as string).filter(Boolean);
}

/**
 * Generate daily lessons for upcoming weekdays and add to queue.
 */
export async function generateLessonQueue(days: number = 10): Promise<{
  generated: number; errors: number;
}> {
  if (generating) return { generated: 0, errors: 0 };
  generating = true;

  try {
    const existingDates = getExistingQueueDates('daily_lesson');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dates = getNextWeekdays(tomorrow, days, existingDates);

    if (dates.length === 0) {
      queueLog.info('No dates need daily lessons — queue is full');
      return { generated: 0, errors: 0 };
    }

    // Build dedup context: recent posted + queued topics
    const postedTopics = getRecentLessonTopics(10);
    const queuedTopics = getQueuedTopics('daily_lesson');
    const allRecentTopics = [...new Set([...postedTopics, ...queuedTopics])];

    const users = getAllUsers().filter(u => u.onboarded);
    const avgLevel = users.length > 0
      ? Math.round(users.reduce((sum, u) => sum + u.level, 0) / users.length)
      : 2;

    let generated = 0;
    let errors = 0;

    for (const date of dates) {
      try {
        const { lesson, blocks } = await generateDailyLesson(avgLevel, allRecentTopics);
        insertQueueItem({
          contentType: 'daily_lesson',
          scheduledDate: date,
          title: lesson.title,
          contentJson: JSON.stringify(lesson),
          blocksJson: JSON.stringify(blocks),
          difficulty: lesson.difficulty,
        });
        // Add to dedup list for next iteration
        allRecentTopics.push(lesson.title);
        generated++;
        queueLog.info(`Queued daily lesson for ${date}: "${lesson.title}"`);
      } catch (err) {
        errors++;
        queueLog.error(`Failed to generate lesson for ${date}: ${err}`);
      }
    }

    queueLog.info(`Lesson queue: ${generated} generated, ${errors} errors`);
    return { generated, errors };
  } finally {
    generating = false;
  }
}

/**
 * Generate lunfardo posts for upcoming days and add to queue.
 */
export async function generateLunfardoQueue(days: number = 14): Promise<{
  generated: number; errors: number;
}> {
  if (generating) return { generated: 0, errors: 0 };
  generating = true;

  try {
    const existingDates = getExistingQueueDates('lunfardo');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dates = getNextDays(tomorrow, days, existingDates);

    if (dates.length === 0) {
      queueLog.info('No dates need lunfardo posts — queue is full');
      return { generated: 0, errors: 0 };
    }

    let generated = 0;
    let errors = 0;

    for (const date of dates) {
      try {
        const { post, blocks } = await generateLunfardoPost();
        insertQueueItem({
          contentType: 'lunfardo',
          scheduledDate: date,
          title: post.word,
          contentJson: JSON.stringify(post),
          blocksJson: JSON.stringify(blocks),
        });
        generated++;
        queueLog.info(`Queued lunfardo for ${date}: "${post.word}"`);
      } catch (err) {
        errors++;
        queueLog.error(`Failed to generate lunfardo for ${date}: ${err}`);
      }
    }

    queueLog.info(`Lunfardo queue: ${generated} generated, ${errors} errors`);
    return { generated, errors };
  } finally {
    generating = false;
  }
}

/**
 * Regenerate a single queue item via LLM.
 */
export async function regenerateQueueItem(id: number): Promise<QueueItem | null> {
  const item = getQueueItem(id);
  if (!item) return null;

  if (item.contentType === 'daily_lesson') {
    const avgLevel = item.difficulty ?? 2;
    const { lesson, blocks } = await generateDailyLesson(avgLevel);
    updateQueueItem(id, {
      title: lesson.title,
      contentJson: JSON.stringify(lesson),
      blocksJson: JSON.stringify(blocks),
      difficulty: lesson.difficulty,
      status: 'ready',
    });
    queueLog.info(`Regenerated queue item ${id}: "${lesson.title}"`);
  } else {
    const { post, blocks } = await generateLunfardoPost();
    updateQueueItem(id, {
      title: post.word,
      contentJson: JSON.stringify(post),
      blocksJson: JSON.stringify(blocks),
      status: 'ready',
    });
    queueLog.info(`Regenerated queue item ${id}: "${post.word}"`);
  }

  return getQueueItem(id);
}
