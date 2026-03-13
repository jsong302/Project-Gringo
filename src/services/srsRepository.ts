/**
 * SRS Repository — Database CRUD for srs_cards and review_log.
 *
 * All DB operations for spaced repetition cards and reviews.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import type { Sm2Result } from './srs';

const srsLog = log.withScope('srs-repo');

// ── Types ───────────────────────────────────────────────────

export type CardType = 'vocab' | 'conjugation' | 'phrase' | 'vesre';

export interface SrsCard {
  id: number;
  userId: number;
  cardType: CardType;
  contentId: number;
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReviewAt: string;
  lastReviewAt: string | null;
  createdAt: string;
}

export interface ReviewLogEntry {
  id: number;
  userId: number;
  srsCardId: number;
  quality: number;
  responseType: 'voice' | 'text' | 'button' | null;
  responseText: string | null;
  feedbackGiven: string | null;
  reviewedAt: string;
}

export interface CardStats {
  total: number;
  due: number;
  learning: number;    // interval < 6 days
  reviewing: number;   // interval >= 6 days
}

// ── Card CRUD ───────────────────────────────────────────────

export function createCard(
  userId: number,
  cardType: CardType,
  contentId: number,
): number {
  const db = getDb();
  db.run(
    `INSERT OR IGNORE INTO srs_cards (user_id, card_type, content_id)
     VALUES (${userId}, '${cardType}', ${contentId})`,
  );

  const result = db.exec(
    `SELECT id FROM srs_cards
     WHERE user_id = ${userId} AND card_type = '${cardType}' AND content_id = ${contentId}`,
  );

  const id = result[0]?.values[0]?.[0] as number;
  srsLog.debug(`Card created/found: id=${id} type=${cardType} content=${contentId}`);
  return id;
}

export function getCardById(cardId: number): SrsCard | null {
  const db = getDb();
  const result = db.exec(`SELECT * FROM srs_cards WHERE id = ${cardId}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToCard(result[0].values[0]);
}

export function getCardsDue(userId: number, limit = 20): SrsCard[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM srs_cards
     WHERE user_id = ${userId}
       AND next_review_at <= datetime('now')
     ORDER BY next_review_at ASC
     LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToCard);
}

export function getCardsByUser(userId: number): SrsCard[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM srs_cards WHERE user_id = ${userId} ORDER BY next_review_at ASC`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToCard);
}

export function updateCardAfterReview(cardId: number, sm2Result: Sm2Result): void {
  const db = getDb();
  db.run(
    `UPDATE srs_cards SET
       ease_factor = ${sm2Result.easeFactor},
       interval_days = ${sm2Result.interval},
       repetitions = ${sm2Result.repetitions},
       next_review_at = '${sm2Result.nextReviewAt}',
       last_review_at = datetime('now')
     WHERE id = ${cardId}`,
  );
  srsLog.debug(`Card ${cardId} updated: interval=${sm2Result.interval}d, next=${sm2Result.nextReviewAt}`);
}

export function getUserCardStats(userId: number): CardStats {
  const db = getDb();

  const totalResult = db.exec(
    `SELECT COUNT(*) FROM srs_cards WHERE user_id = ${userId}`,
  );
  const total = (totalResult[0]?.values[0]?.[0] as number) ?? 0;

  const dueResult = db.exec(
    `SELECT COUNT(*) FROM srs_cards
     WHERE user_id = ${userId} AND next_review_at <= datetime('now')`,
  );
  const due = (dueResult[0]?.values[0]?.[0] as number) ?? 0;

  const learningResult = db.exec(
    `SELECT COUNT(*) FROM srs_cards
     WHERE user_id = ${userId} AND interval_days < 6`,
  );
  const learning = (learningResult[0]?.values[0]?.[0] as number) ?? 0;

  const reviewingResult = db.exec(
    `SELECT COUNT(*) FROM srs_cards
     WHERE user_id = ${userId} AND interval_days >= 6`,
  );
  const reviewing = (reviewingResult[0]?.values[0]?.[0] as number) ?? 0;

  return { total, due, learning, reviewing };
}

// ── Review Log ──────────────────────────────────────────────

export function logReview(
  userId: number,
  srsCardId: number,
  quality: number,
  responseType?: 'voice' | 'text' | 'button',
  responseText?: string,
  feedbackGiven?: string,
): number {
  const db = getDb();
  db.run(
    `INSERT INTO review_log (user_id, srs_card_id, quality, response_type, response_text, feedback_given)
     VALUES (${userId}, ${srsCardId}, ${quality}, ${responseType ? `'${responseType}'` : 'NULL'}, ${responseText ? `'${escapeSql(responseText)}'` : 'NULL'}, ${feedbackGiven ? `'${escapeSql(feedbackGiven)}'` : 'NULL'})`,
  );

  const result = db.exec('SELECT last_insert_rowid()');
  return (result[0]?.values[0]?.[0] as number) ?? 0;
}

export function getReviewHistory(userId: number, limit = 50): ReviewLogEntry[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM review_log
     WHERE user_id = ${userId}
     ORDER BY reviewed_at DESC
     LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToReviewLog);
}

// ── Batch operations ────────────────────────────────────────

export function createCardsForUser(
  userId: number,
  cards: Array<{ cardType: CardType; contentId: number }>,
): number {
  let created = 0;
  for (const card of cards) {
    const db = getDb();
    const before = db.exec(
      `SELECT COUNT(*) FROM srs_cards
       WHERE user_id = ${userId} AND card_type = '${card.cardType}' AND content_id = ${card.contentId}`,
    );
    const existsBefore = ((before[0]?.values[0]?.[0] as number) ?? 0) > 0;

    createCard(userId, card.cardType, card.contentId);

    if (!existsBefore) created++;
  }
  srsLog.info(`Created ${created} new cards for user ${userId} (${cards.length - created} already existed)`);
  return created;
}

// ── Row mappers ─────────────────────────────────────────────

function rowToCard(row: unknown[]): SrsCard {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    cardType: row[2] as CardType,
    contentId: row[3] as number,
    easeFactor: row[4] as number,
    intervalDays: row[5] as number,
    repetitions: row[6] as number,
    nextReviewAt: row[7] as string,
    lastReviewAt: row[8] as string | null,
    createdAt: row[9] as string,
  };
}

function rowToReviewLog(row: unknown[]): ReviewLogEntry {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    srsCardId: row[2] as number,
    quality: row[3] as number,
    responseType: row[4] as ReviewLogEntry['responseType'],
    responseText: row[5] as string | null,
    feedbackGiven: row[6] as string | null,
    reviewedAt: row[7] as string,
  };
}

// ── Helpers ─────────────────────────────────────────────────

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
