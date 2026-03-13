/**
 * Learning Error Tracker — persist and query student mistakes.
 *
 * Feeds into the user memory system and future admin error insights.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const errorLog = log.withScope('error-tracker');

// ── Types ───────────────────────────────────────────────────

export type ErrorCategory = 'grammar' | 'vocab' | 'conjugation' | 'pronunciation' | 'syntax' | 'other';
export type ErrorSource = 'voice' | 'text' | 'review';

export interface LearningError {
  id: number;
  userId: number;
  errorCategory: ErrorCategory;
  description: string;
  userSaid: string | null;
  correction: string | null;
  source: ErrorSource | null;
  createdAt: string;
}

export interface ErrorSummary {
  category: ErrorCategory;
  count: number;
}

// ── CRUD ────────────────────────────────────────────────────

export function logLearningError(
  userId: number,
  category: ErrorCategory,
  description: string,
  userSaid?: string,
  correction?: string,
  source?: ErrorSource,
): number {
  const db = getDb();
  db.run(
    `INSERT INTO learning_errors (user_id, error_category, description, user_said, correction, source)
     VALUES (${userId}, '${category}', '${esc(description)}',
             ${userSaid ? `'${esc(userSaid)}'` : 'NULL'},
             ${correction ? `'${esc(correction)}'` : 'NULL'},
             ${source ? `'${source}'` : 'NULL'})`,
  );

  const result = db.exec('SELECT last_insert_rowid()');
  const id = (result[0]?.values[0]?.[0] as number) ?? 0;

  errorLog.debug(`Learning error logged: ${category} for user ${userId}`);
  return id;
}

/**
 * Log multiple errors from a grading result.
 */
export function logGradingErrors(
  userId: number,
  errors: Array<{ type: ErrorCategory; description: string; correction: string }>,
  userSaid: string,
  source: ErrorSource,
): void {
  for (const err of errors) {
    logLearningError(userId, err.type, err.description, userSaid, err.correction, source);
  }
}

export function getRecentErrors(userId: number, limit = 20): LearningError[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM learning_errors
     WHERE user_id = ${userId}
     ORDER BY created_at DESC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToError);
}

export function getErrorSummary(userId: number): ErrorSummary[] {
  const db = getDb();
  const result = db.exec(
    `SELECT error_category, COUNT(*) as count
     FROM learning_errors
     WHERE user_id = ${userId}
     GROUP BY error_category
     ORDER BY count DESC`,
  );
  if (!result.length) return [];
  return result[0].values.map((row) => ({
    category: row[0] as ErrorCategory,
    count: row[1] as number,
  }));
}

export function getTotalErrorCount(userId: number): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM learning_errors WHERE user_id = ${userId}`,
  );
  return (result[0]?.values[0]?.[0] as number) ?? 0;
}

// ── Row mapper ──────────────────────────────────────────────

function rowToError(row: unknown[]): LearningError {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    errorCategory: row[2] as ErrorCategory,
    description: row[3] as string,
    userSaid: row[4] as string | null,
    correction: row[5] as string | null,
    source: row[6] as ErrorSource | null,
    createdAt: row[7] as string,
  };
}

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
