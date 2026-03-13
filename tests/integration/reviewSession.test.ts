import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { createCardsForUser } from '../../src/services/srsRepository';
import { seedVocabulary, seedConjugations, seedPhrases, seedVesre } from '../../src/services/seedContent';
import {
  startReviewSession,
  getCurrentCard,
  scoreCard,
  scoreCardByLabel,
  completeSession,
  abandonSession,
  getActiveSession,
  formatCardBlocks,
  formatAnswerBlocks,
  formatSummaryBlocks,
  _clearSessions,
} from '../../src/services/reviewSession';

const TEST_DB_PATH = './data/test-review-session.db';

describe('Review Session', () => {
  let userId: number;
  const channelId = 'C_TEST_REVIEW';
  const threadTs = '1234567890.000100';

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    // Create user
    db.run(`INSERT INTO users (slack_user_id, display_name) VALUES ('U_REVIEW', 'Review User')`);
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_REVIEW'`);
    userId = result[0].values[0][0] as number;

    // Seed content
    seedVocabulary();
    seedConjugations();
    seedPhrases();
    seedVesre();

    // Create SRS cards for the user (vocab ids 1-5)
    createCardsForUser(userId, [
      { cardType: 'vocab', contentId: 1 },
      { cardType: 'vocab', contentId: 2 },
      { cardType: 'vocab', contentId: 3 },
      { cardType: 'conjugation', contentId: 1 },
      { cardType: 'phrase', contentId: 1 },
    ]);
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(() => {
    _clearSessions();
    // Reset all cards to be due now (previous tests may have pushed them to the future)
    const db = getDb();
    db.run(`UPDATE srs_cards SET next_review_at = datetime('now'), ease_factor = 2.5, interval_days = 0, repetitions = 0, last_review_at = NULL WHERE user_id = ${userId}`);
  });

  describe('startReviewSession', () => {
    it('should start a session with due cards', () => {
      const session = startReviewSession(userId, channelId, threadTs);
      expect(session).not.toBeNull();
      expect(session!.cards.length).toBeGreaterThan(0);
      expect(session!.currentIndex).toBe(0);
      expect(session!.status).toBe('active');
    });

    it('should return null if session already active', () => {
      startReviewSession(userId, channelId, threadTs);
      const second = startReviewSession(userId, channelId, threadTs);
      expect(second).toBeNull();
    });

    it('should limit cards', () => {
      const session = startReviewSession(userId, channelId, threadTs, 2);
      expect(session).not.toBeNull();
      expect(session!.cards.length).toBeLessThanOrEqual(2);
    });
  });

  describe('getCurrentCard', () => {
    it('should return the first card', () => {
      const session = startReviewSession(userId, channelId, threadTs)!;
      const presented = getCurrentCard(session);
      expect(presented).not.toBeNull();
      expect(presented!.cardNumber).toBe(1);
      expect(presented!.content.front).toBeTruthy();
      expect(presented!.content.back).toBeTruthy();
    });

    it('should return null when all cards reviewed', () => {
      const session = startReviewSession(userId, channelId, threadTs, 1)!;
      scoreCard(session, 4);
      const next = getCurrentCard(session);
      expect(next).toBeNull();
    });
  });

  describe('scoreCard', () => {
    it('should update card and advance session', () => {
      const session = startReviewSession(userId, channelId, threadTs, 3)!;
      const result = scoreCard(session, 4);
      expect(result.quality).toBe(4);
      expect(result.newInterval).toBeGreaterThan(0);
      expect(session.currentIndex).toBe(1);
      expect(session.results.length).toBe(1);
    });
  });

  describe('scoreCardByLabel', () => {
    it('should score using label', () => {
      const session = startReviewSession(userId, channelId, threadTs, 3)!;
      const result = scoreCardByLabel(session, 'good');
      expect(result.quality).toBe(4);
    });

    it('should handle "again" label (reset)', () => {
      const session = startReviewSession(userId, channelId, threadTs, 3)!;
      const result = scoreCardByLabel(session, 'again');
      expect(result.quality).toBe(1);
      expect(result.newInterval).toBe(1); // Reset to 1 day
    });
  });

  describe('completeSession', () => {
    it('should return summary with stats', () => {
      const session = startReviewSession(userId, channelId, threadTs, 2)!;
      scoreCard(session, 5);
      scoreCard(session, 2);

      const summary = completeSession(userId, channelId);
      expect(summary).not.toBeNull();
      expect(summary!.totalReviewed).toBe(2);
      expect(summary!.correct).toBe(1);
      expect(summary!.incorrect).toBe(1);
      expect(summary!.averageQuality).toBe(3.5);
      expect(summary!.stats.total).toBeGreaterThan(0);
    });

    it('should clear active session after completion', () => {
      const session = startReviewSession(userId, channelId, threadTs, 1)!;
      scoreCard(session, 4);
      completeSession(userId, channelId);

      expect(getActiveSession(userId, channelId)).toBeNull();
    });
  });

  describe('abandonSession', () => {
    it('should clear active session', () => {
      startReviewSession(userId, channelId, threadTs);
      abandonSession(userId, channelId);
      expect(getActiveSession(userId, channelId)).toBeNull();
    });
  });

  describe('getActiveSession', () => {
    it('should return active session', () => {
      startReviewSession(userId, channelId, threadTs);
      expect(getActiveSession(userId, channelId)).not.toBeNull();
    });

    it('should return null when no session', () => {
      expect(getActiveSession(userId, channelId)).toBeNull();
    });
  });

  describe('Block Kit formatting', () => {
    it('should format card blocks', () => {
      const session = startReviewSession(userId, channelId, threadTs)!;
      const presented = getCurrentCard(session)!;
      const blocks = formatCardBlocks(presented);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect((blocks[0] as any).type).toBe('header');
    });

    it('should format answer blocks with buttons', () => {
      const session = startReviewSession(userId, channelId, threadTs)!;
      const presented = getCurrentCard(session)!;
      const blocks = formatAnswerBlocks(presented.content);
      expect(blocks.length).toBe(2);
      const actions = blocks[1] as any;
      expect(actions.type).toBe('actions');
      expect(actions.elements.length).toBe(4);
    });

    it('should format summary blocks', () => {
      const summary = {
        totalReviewed: 5,
        correct: 4,
        incorrect: 1,
        averageQuality: 4.2,
        stats: { total: 10, due: 2, learning: 3, reviewing: 7 },
      };
      const blocks = formatSummaryBlocks(summary);
      expect(blocks.length).toBe(2);
      expect((blocks[0] as any).type).toBe('header');
      const text = (blocks[1] as any).text.text;
      expect(text).toContain('80%');
      expect(text).toContain('4.2');
    });
  });
});
