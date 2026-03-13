import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { getMemory, upsertMemory, getMemoryForPrompt, buildMemoryContext } from '../../src/services/userMemory';
import { logLearningError } from '../../src/services/errorTracker';
import { createCardsForUser } from '../../src/services/srsRepository';
import { seedVocabulary } from '../../src/services/seedContent';

const TEST_DB_PATH = './data/test-user-memory.db';

describe('User Memory', () => {
  let userId: number;

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });

    const db = getDb();
    db.run(`INSERT INTO users (slack_user_id, display_name, level, xp, streak_days) VALUES ('U_MEM', 'Memory User', 2, 150, 5)`);
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_MEM'`);
    userId = result[0].values[0][0] as number;

    // Seed some vocab and create cards
    seedVocabulary();
    createCardsForUser(userId, [
      { cardType: 'vocab', contentId: 1 },
      { cardType: 'vocab', contentId: 2 },
      { cardType: 'vocab', contentId: 3 },
    ]);

    // Log some errors
    logLearningError(userId, 'conjugation', 'Used tú instead of vos', 'tu hablas', 'vos hablás', 'voice');
    logLearningError(userId, 'conjugation', 'Wrong tense for ir', 'yo fue', 'yo fui', 'text');
    logLearningError(userId, 'grammar', 'Missing accent', 'como estas', 'cómo estás', 'text');
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('getMemory / upsertMemory', () => {
    it('should return null when no memory exists', () => {
      expect(getMemory(userId)).toBeNull();
    });

    it('should create memory', () => {
      upsertMemory(userId, 'Level 2 student, struggles with voseo', 'vocabulary', 'conjugation, accents', 'food, travel');
      const mem = getMemory(userId);
      expect(mem).not.toBeNull();
      expect(mem!.profileSummary).toContain('voseo');
      expect(mem!.strengths).toBe('vocabulary');
      expect(mem!.weaknesses).toContain('conjugation');
    });

    it('should update (upsert) memory', () => {
      upsertMemory(userId, 'Updated profile: improving', 'vocabulary, greetings', 'subjunctive');
      const mem = getMemory(userId);
      expect(mem!.profileSummary).toContain('improving');
      expect(mem!.strengths).toContain('greetings');
    });
  });

  describe('getMemoryForPrompt', () => {
    it('should return formatted string for prompt injection', () => {
      const prompt = getMemoryForPrompt(userId);
      expect(prompt).toContain('Learner profile:');
      expect(prompt).toContain('Strengths:');
      expect(prompt).toContain('Weaknesses:');
    });

    it('should return empty string for user with no memory', () => {
      expect(getMemoryForPrompt(99999)).toBe('');
    });
  });

  describe('buildMemoryContext', () => {
    it('should include user stats', () => {
      const context = buildMemoryContext(userId);
      expect(context).toContain('level 2');
      expect(context).toContain('150 XP');
      expect(context).toContain('5-day streak');
    });

    it('should include SRS stats', () => {
      const context = buildMemoryContext(userId);
      expect(context).toContain('SRS:');
      expect(context).toContain('3 cards');
    });

    it('should include error data', () => {
      const context = buildMemoryContext(userId);
      expect(context).toContain('Error distribution');
      expect(context).toContain('conjugation');
      expect(context).toContain('Recent errors');
      expect(context).toContain('vos hablás');
    });

    it('should return empty for missing user', () => {
      expect(buildMemoryContext(99999)).toBe('');
    });
  });
});
