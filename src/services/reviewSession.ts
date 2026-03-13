/**
 * Review Session Manager
 *
 * Orchestrates an SRS review session:
 *  1. Fetch due cards
 *  2. Present each card
 *  3. Score response (button or LLM-graded)
 *  4. Update SM-2 data
 *  5. Show session summary
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import { sm2 } from './srs';
import type { QualityLabel } from './srs';
import { qualityFromLabel } from './srs';
import {
  getCardsDue,
  getCardById,
  updateCardAfterReview,
  logReview,
  getUserCardStats,
} from './srsRepository';
import type { SrsCard, CardStats } from './srsRepository';
import { getCardContent } from './cardContent';
import type { CardContent } from './cardContent';

const sessionLog = log.withScope('review');

// ── Types ───────────────────────────────────────────────────

export interface ReviewSession {
  id: number;           // conversation_threads.id
  userId: number;
  cards: SrsCard[];
  currentIndex: number;
  results: ReviewResult[];
  status: 'active' | 'completed' | 'abandoned';
}

export interface ReviewResult {
  cardId: number;
  quality: number;
  previousInterval: number;
  newInterval: number;
}

export interface PresentedCard {
  card: SrsCard;
  content: CardContent;
  cardNumber: number;
  totalCards: number;
}

export interface SessionSummary {
  totalReviewed: number;
  correct: number;         // quality >= 3
  incorrect: number;       // quality < 3
  averageQuality: number;
  stats: CardStats;
}

// ── In-memory session store (keyed by `userId:channelId`) ───
// Write-through cache: Map for performance, DB for persistence

const activeSessions = new Map<string, ReviewSession>();

function sessionKey(userId: number, channelId: string): string {
  return `${userId}:${channelId}`;
}

// ── DB persistence helpers ──────────────────────────────────

function persistSession(session: ReviewSession, channelId: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO review_sessions (user_id, conversation_id, cards_json, current_index, results_json, status)
     VALUES (${session.userId}, ${session.id}, '${esc(JSON.stringify(session.cards.map((c) => c.id)))}', ${session.currentIndex}, '${esc(JSON.stringify(session.results))}', '${session.status}')`,
  );
}

function updatePersistedSession(session: ReviewSession): void {
  const db = getDb();
  db.run(
    `UPDATE review_sessions
     SET current_index = ${session.currentIndex},
         results_json = '${esc(JSON.stringify(session.results))}',
         status = '${session.status}',
         updated_at = datetime('now')
     WHERE conversation_id = ${session.id}`,
  );
}

function esc(str: string): string {
  return str.replace(/'/g, "''");
}

// ── Session lifecycle ───────────────────────────────────────

export function startReviewSession(
  userId: number,
  channelId: string,
  threadTs: string,
  maxCards = 10,
): ReviewSession | null {
  const key = sessionKey(userId, channelId);

  // Check for existing active session
  const existing = activeSessions.get(key);
  if (existing && existing.status === 'active') {
    sessionLog.warn(`User ${userId} already has active session in ${channelId}`);
    return null; // Caller should tell user to finish current session
  }

  // Fetch due cards
  const cards = getCardsDue(userId, maxCards);
  if (cards.length === 0) {
    sessionLog.info(`No cards due for user ${userId}`);
    return null;
  }

  // Create conversation thread record
  const db = getDb();
  db.run(
    `INSERT INTO conversation_threads (user_id, slack_channel_id, slack_thread_ts, thread_type, status)
     VALUES (${userId}, '${channelId}', '${threadTs}', 'review', 'active')`,
  );
  const result = db.exec('SELECT last_insert_rowid()');
  const threadId = (result[0]?.values[0]?.[0] as number) ?? 0;

  const session: ReviewSession = {
    id: threadId,
    userId,
    cards,
    currentIndex: 0,
    results: [],
    status: 'active',
  };

  activeSessions.set(key, session);
  persistSession(session, channelId);
  sessionLog.info(`Started review session: ${cards.length} cards for user ${userId}`);
  return session;
}

export function getCurrentCard(session: ReviewSession): PresentedCard | null {
  if (session.currentIndex >= session.cards.length) return null;

  const card = session.cards[session.currentIndex];
  const content = getCardContent(card);
  if (!content) {
    sessionLog.warn(`Missing content for card ${card.id} (${card.cardType}:${card.contentId})`);
    // Skip this card
    session.currentIndex++;
    return getCurrentCard(session);
  }

  return {
    card,
    content,
    cardNumber: session.currentIndex + 1,
    totalCards: session.cards.length,
  };
}

export function scoreCard(
  session: ReviewSession,
  quality: number,
  responseType: 'voice' | 'text' | 'button' = 'button',
  responseText?: string,
  feedbackGiven?: string,
): ReviewResult {
  const card = session.cards[session.currentIndex];

  // Run SM-2
  const sm2Result = sm2(
    {
      easeFactor: card.easeFactor,
      interval: card.intervalDays,
      repetitions: card.repetitions,
    },
    quality,
  );

  // Update card in DB
  updateCardAfterReview(card.id, sm2Result);

  // Log the review
  logReview(session.userId, card.id, quality, responseType, responseText, feedbackGiven);

  const result: ReviewResult = {
    cardId: card.id,
    quality,
    previousInterval: card.intervalDays,
    newInterval: sm2Result.interval,
  };

  session.results.push(result);
  session.currentIndex++;

  // Update conversation thread turn count
  const db = getDb();
  db.run(
    `UPDATE conversation_threads SET turn_count = ${session.currentIndex}, updated_at = datetime('now')
     WHERE id = ${session.id}`,
  );

  // Persist session state to DB
  updatePersistedSession(session);

  return result;
}

export function scoreCardByLabel(
  session: ReviewSession,
  label: QualityLabel,
): ReviewResult {
  return scoreCard(session, qualityFromLabel(label), 'button');
}

export function completeSession(
  userId: number,
  channelId: string,
): SessionSummary | null {
  const key = sessionKey(userId, channelId);
  const session = activeSessions.get(key);
  if (!session) return null;

  session.status = 'completed';

  // Update DB
  const db = getDb();
  db.run(
    `UPDATE conversation_threads SET status = 'completed', updated_at = datetime('now')
     WHERE id = ${session.id}`,
  );

  // Persist completed status
  updatePersistedSession(session);

  const summary = getSessionSummary(session);
  activeSessions.delete(key);

  sessionLog.info(
    `Session complete: ${summary.totalReviewed} reviewed, ${summary.correct} correct, avg quality ${summary.averageQuality.toFixed(1)}`,
  );

  return summary;
}

export function abandonSession(userId: number, channelId: string): void {
  const key = sessionKey(userId, channelId);
  const session = activeSessions.get(key);
  if (!session) return;

  session.status = 'abandoned';

  const db = getDb();
  db.run(
    `UPDATE conversation_threads SET status = 'abandoned', updated_at = datetime('now')
     WHERE id = ${session.id}`,
  );

  updatePersistedSession(session);
  activeSessions.delete(key);
  sessionLog.info(`Session abandoned for user ${userId}`);
}

export function getActiveSession(
  userId: number,
  channelId: string,
): ReviewSession | null {
  const key = sessionKey(userId, channelId);
  return activeSessions.get(key) ?? null;
}

// ── Summary ─────────────────────────────────────────────────

function getSessionSummary(session: ReviewSession): SessionSummary {
  const results = session.results;
  const totalReviewed = results.length;
  const correct = results.filter((r) => r.quality >= 3).length;
  const incorrect = totalReviewed - correct;
  const averageQuality = totalReviewed > 0
    ? results.reduce((sum, r) => sum + r.quality, 0) / totalReviewed
    : 0;

  const stats = getUserCardStats(session.userId);

  return { totalReviewed, correct, incorrect, averageQuality, stats };
}

// ── Block Kit formatting ────────────────────────────────────

export function formatCardBlocks(presented: PresentedCard): object[] {
  const { card, content, cardNumber, totalCards } = presented;
  const difficultyStars = content.difficulty
    ? '★'.repeat(content.difficulty) + '☆'.repeat(5 - content.difficulty)
    : '';

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📚 Repaso — Carta ${cardNumber}/${totalCards}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${content.front}*${difficultyStars ? `\n${difficultyStars}` : ''}`,
      },
    },
  ];

  if (content.hint) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `💡 _${content.hint}_` }],
    });
  }

  return blocks;
}

export function formatAnswerBlocks(content: CardContent): object[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `✅ *Respuesta:* ${content.back}` },
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '🔄 De nuevo' }, action_id: 'srs_again', value: 'again', style: 'danger' },
        { type: 'button', text: { type: 'plain_text', text: '😓 Difícil' }, action_id: 'srs_hard', value: 'hard' },
        { type: 'button', text: { type: 'plain_text', text: '👍 Bien' }, action_id: 'srs_good', value: 'good', style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: '🚀 Fácil' }, action_id: 'srs_easy', value: 'easy' },
      ],
    },
  ];
}

export function formatSummaryBlocks(summary: SessionSummary): object[] {
  const percentage = summary.totalReviewed > 0
    ? Math.round((summary.correct / summary.totalReviewed) * 100)
    : 0;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🎉 Repaso completado!' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Cartas repasadas:* ${summary.totalReviewed}`,
          `*Correctas:* ${summary.correct} (${percentage}%)`,
          `*A repasar:* ${summary.incorrect}`,
          `*Calidad promedio:* ${summary.averageQuality.toFixed(1)}/5`,
          '',
          `📊 *Tu progreso:*`,
          `• Total de cartas: ${summary.stats.total}`,
          `• Pendientes hoy: ${summary.stats.due}`,
          `• Aprendiendo: ${summary.stats.learning}`,
          `• En repaso: ${summary.stats.reviewing}`,
        ].join('\n'),
      },
    },
  ];
}

// ── Test helper ─────────────────────────────────────────────

// ── Session recovery (on startup) ────────────────────────────

/**
 * Recover active review sessions from DB into memory.
 * Call this once during app startup after DB is initialized.
 */
export function recoverSessions(): number {
  const db = getDb();
  const result = db.exec(
    `SELECT rs.user_id, rs.conversation_id, rs.cards_json, rs.current_index, rs.results_json, rs.status,
            ct.slack_channel_id
     FROM review_sessions rs
     JOIN conversation_threads ct ON ct.id = rs.conversation_id
     WHERE rs.status = 'active'`,
  );

  if (!result.length) return 0;

  let recovered = 0;
  for (const row of result[0].values) {
    const userId = row[0] as number;
    const conversationId = row[1] as number;
    const cardIds = JSON.parse(row[2] as string) as number[];
    const currentIndex = row[3] as number;
    const results = JSON.parse(row[4] as string) as ReviewResult[];
    const channelId = row[6] as string;

    // Reload actual card objects from DB
    const cards: SrsCard[] = [];
    for (const cardId of cardIds) {
      const card = getCardById(cardId);
      if (card) cards.push(card);
    }

    if (cards.length === 0) continue;

    const session: ReviewSession = {
      id: conversationId,
      userId,
      cards,
      currentIndex,
      results,
      status: 'active',
    };

    const key = sessionKey(userId, channelId);
    activeSessions.set(key, session);
    recovered++;
  }

  if (recovered > 0) {
    sessionLog.info(`Recovered ${recovered} active review sessions from DB`);
  }
  return recovered;
}

/** @internal — test-only: clear all in-memory sessions */
export function _clearSessions(): void {
  activeSessions.clear();
}
