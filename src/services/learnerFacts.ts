/**
 * Learner Facts — discrete structured observations about students.
 *
 * Follows the Mem0 pattern: extract individual facts during conversation
 * via tool use, store as structured entries, inject into prompts.
 * Each fact is a concise observation (e.g. "Confuses ser/estar",
 * "Interested in football vocabulary").
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const factsLog = log.withScope('learner-facts');

// ── Types ───────────────────────────────────────────────────

export type FactCategory =
  | 'error_pattern'
  | 'strength'
  | 'interest'
  | 'preference'
  | 'knowledge_gap'
  | 'pronunciation'
  | 'other';

export type FactSource = 'tool' | 'pronunciation' | 'review' | 'onboarding' | 'system';

export interface LearnerFact {
  id: number;
  userId: number;
  category: FactCategory;
  fact: string;
  source: FactSource | null;
  supersededBy: number | null;
  createdAt: string;
}

// ── CRUD ────────────────────────────────────────────────────

/**
 * Save a learner fact. Skips if an identical fact already exists
 * for this user + category (simple deduplication).
 */
export function saveLearnerFact(
  userId: number,
  category: string,
  fact: string,
  source: string,
): number {
  const db = getDb();

  // Simple dedup: skip if exact same fact text exists for this user
  const existing = db.exec(
    `SELECT id FROM learner_facts
     WHERE user_id = ${userId} AND fact = '${esc(fact)}' AND superseded_by IS NULL`,
  );
  if (existing.length && existing[0].values.length) {
    factsLog.debug(`Duplicate fact skipped for user ${userId}: "${fact.slice(0, 40)}"`);
    return existing[0].values[0][0] as number;
  }

  db.run(
    `INSERT INTO learner_facts (user_id, category, fact, source)
     VALUES (${userId}, '${esc(category)}', '${esc(fact)}', '${esc(source)}')`,
  );

  const result = db.exec('SELECT last_insert_rowid()');
  const id = (result[0]?.values[0]?.[0] as number) ?? 0;

  factsLog.info(`Fact logged for user ${userId}: [${category}] ${fact.slice(0, 60)}`);
  return id;
}

/**
 * Get active learner facts (not superseded), ordered by most recent.
 */
export function getLearnerFacts(userId: number, limit = 30): LearnerFact[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM learner_facts
     WHERE user_id = ${userId} AND superseded_by IS NULL
     ORDER BY created_at DESC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToFact);
}

/**
 * Get facts filtered by category.
 */
export function getLearnerFactsByCategory(
  userId: number,
  category: string,
): LearnerFact[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM learner_facts
     WHERE user_id = ${userId} AND category = '${esc(category)}' AND superseded_by IS NULL
     ORDER BY created_at DESC`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToFact);
}

/**
 * Mark an old fact as superseded by a new one.
 */
export function supersedeFact(factId: number, newFactId: number): void {
  const db = getDb();
  db.run(
    `UPDATE learner_facts SET superseded_by = ${newFactId} WHERE id = ${factId}`,
  );
  factsLog.debug(`Fact ${factId} superseded by ${newFactId}`);
}

/**
 * Get total active fact count for a user.
 */
export function getFactCount(userId: number): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM learner_facts
     WHERE user_id = ${userId} AND superseded_by IS NULL`,
  );
  return (result[0]?.values[0]?.[0] as number) ?? 0;
}

// ── Row mapper ──────────────────────────────────────────────

function rowToFact(row: unknown[]): LearnerFact {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    category: row[2] as FactCategory,
    fact: row[3] as string,
    source: row[4] as FactSource | null,
    supersededBy: row[5] as number | null,
    createdAt: row[6] as string,
  };
}

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
