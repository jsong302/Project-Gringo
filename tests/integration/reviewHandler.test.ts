import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { seedVocabulary, seedConjugations, seedPhrases, seedVesre } from '../../src/services/seedContent';
import { ensureUser, ensureUserHasCards } from '../../src/handlers/reviewHandler';
import { getUserCardStats } from '../../src/services/srsRepository';

const TEST_DB_PATH = './data/test-review-handler.db';

describe('Review Handler', () => {
  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

    await initDb({ path: TEST_DB_PATH });

    // Seed content
    seedVocabulary();
    seedConjugations();
    seedPhrases();
    seedVesre();
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('ensureUser', () => {
    it('should create a new user if not exists', () => {
      const userId = ensureUser('U_HANDLER_NEW');
      expect(userId).toBeGreaterThan(0);
    });

    it('should return existing user on second call', () => {
      const id1 = ensureUser('U_HANDLER_EXIST');
      const id2 = ensureUser('U_HANDLER_EXIST');
      expect(id1).toBe(id2);
    });
  });

  describe('ensureUserHasCards', () => {
    it('should create cards for a user with no cards', () => {
      const userId = ensureUser('U_HANDLER_CARDS');
      const before = getUserCardStats(userId);
      expect(before.total).toBe(0);

      ensureUserHasCards(userId);

      const after = getUserCardStats(userId);
      expect(after.total).toBeGreaterThan(50); // 30 vocab + 24 conj + 20 phrases + 12 vesre = 86
    });

    it('should not create duplicate cards on second call', () => {
      const userId = ensureUser('U_HANDLER_CARDS');
      const before = getUserCardStats(userId);

      ensureUserHasCards(userId);

      const after = getUserCardStats(userId);
      expect(after.total).toBe(before.total);
    });
  });
});
