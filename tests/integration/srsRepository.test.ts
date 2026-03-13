import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import {
  createCard,
  getCardById,
  getCardsDue,
  getCardsByUser,
  updateCardAfterReview,
  getUserCardStats,
  logReview,
  getReviewHistory,
  createCardsForUser,
} from '../../src/services/srsRepository';
import { sm2, DEFAULT_EASE_FACTOR } from '../../src/services/srs';

const TEST_DB_PATH = './data/test-srs-repo.db';

describe('SRS Repository', () => {
  let userId: number;

  beforeAll(async () => {
    // Clean up any previous test DB
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

    await initDb({ path: TEST_DB_PATH });

    // Create a test user
    const db = getDb();
    db.run(
      `INSERT INTO users (slack_user_id, display_name) VALUES ('U_TEST_SRS', 'Test SRS User')`,
    );
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_TEST_SRS'`);
    userId = result[0].values[0][0] as number;

    // Seed some vocabulary content
    db.run(`INSERT INTO vocabulary (id, spanish, english, category, difficulty) VALUES (1, 'mate', 'mate tea', 'comida', 1)`);
    db.run(`INSERT INTO vocabulary (id, spanish, english, category, difficulty) VALUES (2, 'laburo', 'work/job', 'trabajo', 2)`);
    db.run(`INSERT INTO vocabulary (id, spanish, english, category, difficulty) VALUES (3, 'bondi', 'bus', 'transporte', 1)`);

    // Seed a conjugation
    db.run(`INSERT INTO conjugations (id, verb_infinitive, tense, mood, vos_form) VALUES (1, 'hablar', 'presente', 'indicativo', 'hablás')`);
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('createCard', () => {
    it('should create a new card and return its id', () => {
      const id = createCard(userId, 'vocab', 1);
      expect(id).toBeGreaterThan(0);
    });

    it('should return existing card id on duplicate', () => {
      const id1 = createCard(userId, 'vocab', 1);
      const id2 = createCard(userId, 'vocab', 1);
      expect(id1).toBe(id2);
    });

    it('should create cards of different types', () => {
      const vocabId = createCard(userId, 'vocab', 2);
      const conjId = createCard(userId, 'conjugation', 1);
      expect(vocabId).not.toBe(conjId);
    });
  });

  describe('getCardById', () => {
    it('should return a card by id', () => {
      const id = createCard(userId, 'vocab', 3);
      const card = getCardById(id);
      expect(card).not.toBeNull();
      expect(card!.cardType).toBe('vocab');
      expect(card!.contentId).toBe(3);
      expect(card!.easeFactor).toBe(DEFAULT_EASE_FACTOR);
      expect(card!.intervalDays).toBe(0);
      expect(card!.repetitions).toBe(0);
    });

    it('should return null for non-existent card', () => {
      expect(getCardById(99999)).toBeNull();
    });
  });

  describe('getCardsDue', () => {
    it('should return cards that are due for review', () => {
      // All new cards have next_review_at = datetime('now'), so they're due immediately
      const due = getCardsDue(userId);
      expect(due.length).toBeGreaterThan(0);
    });

    it('should respect limit', () => {
      const due = getCardsDue(userId, 1);
      expect(due.length).toBeLessThanOrEqual(1);
    });

    it('should not return cards scheduled for the future', () => {
      // Update a card to be far in the future
      const id = createCard(userId, 'vocab', 1);
      const db = getDb();
      db.run(`UPDATE srs_cards SET next_review_at = '2099-01-01 00:00:00' WHERE id = ${id}`);

      const due = getCardsDue(userId);
      const futureCard = due.find((c) => c.id === id);
      expect(futureCard).toBeUndefined();

      // Reset for other tests
      db.run(`UPDATE srs_cards SET next_review_at = datetime('now') WHERE id = ${id}`);
    });
  });

  describe('getCardsByUser', () => {
    it('should return all cards for a user', () => {
      const cards = getCardsByUser(userId);
      expect(cards.length).toBeGreaterThanOrEqual(3); // vocab 1,2,3 + conjugation 1
    });

    it('should return empty array for user with no cards', () => {
      const cards = getCardsByUser(99999);
      expect(cards).toEqual([]);
    });
  });

  describe('updateCardAfterReview', () => {
    it('should update card with SM-2 result', () => {
      const id = createCard(userId, 'vocab', 1);
      const card = getCardById(id)!;

      const result = sm2(
        { easeFactor: card.easeFactor, interval: card.intervalDays, repetitions: card.repetitions },
        4,
      );

      updateCardAfterReview(id, result);

      const updated = getCardById(id)!;
      expect(updated.easeFactor).toBeCloseTo(result.easeFactor, 2);
      expect(updated.intervalDays).toBe(result.interval);
      expect(updated.repetitions).toBe(result.repetitions);
      expect(updated.lastReviewAt).not.toBeNull();
    });
  });

  describe('getUserCardStats', () => {
    it('should return stats for a user', () => {
      const stats = getUserCardStats(userId);
      expect(stats.total).toBeGreaterThan(0);
      expect(typeof stats.due).toBe('number');
      expect(typeof stats.learning).toBe('number');
      expect(typeof stats.reviewing).toBe('number');
      expect(stats.learning + stats.reviewing).toBe(stats.total);
    });
  });

  describe('logReview', () => {
    it('should log a review and return its id', () => {
      const cardId = createCard(userId, 'vocab', 1);
      const reviewId = logReview(userId, cardId, 4, 'button');
      expect(reviewId).toBeGreaterThan(0);
    });

    it('should log a review with text response', () => {
      const cardId = createCard(userId, 'vocab', 2);
      const reviewId = logReview(
        userId,
        cardId,
        3,
        'text',
        'El laburo es difícil',
        'Muy bien! Usaste "laburo" correctamente.',
      );
      expect(reviewId).toBeGreaterThan(0);
    });
  });

  describe('getReviewHistory', () => {
    it('should return review history for a user', () => {
      const history = getReviewHistory(userId);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].quality).toBeGreaterThanOrEqual(0);
      expect(history[0].quality).toBeLessThanOrEqual(5);
    });

    it('should respect limit', () => {
      const history = getReviewHistory(userId, 1);
      expect(history.length).toBeLessThanOrEqual(1);
    });
  });

  describe('createCardsForUser', () => {
    it('should create multiple cards at once', () => {
      // Create a second user to avoid conflicts
      const db = getDb();
      db.run(`INSERT INTO users (slack_user_id, display_name) VALUES ('U_BATCH', 'Batch User')`);
      const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_BATCH'`);
      const batchUserId = result[0].values[0][0] as number;

      const created = createCardsForUser(batchUserId, [
        { cardType: 'vocab', contentId: 1 },
        { cardType: 'vocab', contentId: 2 },
        { cardType: 'vocab', contentId: 3 },
        { cardType: 'conjugation', contentId: 1 },
      ]);

      expect(created).toBe(4);

      // Running again should create 0 new cards
      const createdAgain = createCardsForUser(batchUserId, [
        { cardType: 'vocab', contentId: 1 },
        { cardType: 'vocab', contentId: 2 },
      ]);
      expect(createdAgain).toBe(0);
    });
  });
});
