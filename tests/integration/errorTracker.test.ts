import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import {
  logLearningError,
  logGradingErrors,
  getRecentErrors,
  getErrorSummary,
  getTotalErrorCount,
} from '../../src/services/errorTracker';

const TEST_DB_PATH = './data/test-error-tracker.db';

describe('Error Tracker', () => {
  let userId: number;

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });

    const db = getDb();
    db.run(`INSERT INTO users (slack_user_id) VALUES ('U_ERR')`);
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_ERR'`);
    userId = result[0].values[0][0] as number;
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('logLearningError', () => {
    it('should log an error and return id', () => {
      const id = logLearningError(userId, 'grammar', 'Used tú instead of vos', 'tu hablas', 'vos hablás', 'voice');
      expect(id).toBeGreaterThan(0);
    });

    it('should log without optional fields', () => {
      const id = logLearningError(userId, 'vocab', 'Unknown word used');
      expect(id).toBeGreaterThan(0);
    });

    it('should handle special characters', () => {
      const id = logLearningError(userId, 'conjugation', "Didn't conjugate correctly", "yo soy's", "vos sos");
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('logGradingErrors', () => {
    it('should log multiple errors from grading', () => {
      const before = getTotalErrorCount(userId);

      logGradingErrors(userId, [
        { type: 'grammar', description: 'Wrong tense', correction: 'Use presente' },
        { type: 'vocab', description: 'Wrong word', correction: 'Use copado' },
      ], 'test response', 'text');

      const after = getTotalErrorCount(userId);
      expect(after - before).toBe(2);
    });
  });

  describe('getRecentErrors', () => {
    it('should return recent errors', () => {
      const errors = getRecentErrors(userId);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].userId).toBe(userId);
    });

    it('should respect limit', () => {
      const errors = getRecentErrors(userId, 2);
      expect(errors.length).toBeLessThanOrEqual(2);
    });

    it('should return most recent first', () => {
      const errors = getRecentErrors(userId);
      for (let i = 1; i < errors.length; i++) {
        expect(errors[i - 1].createdAt >= errors[i].createdAt).toBe(true);
      }
    });
  });

  describe('getErrorSummary', () => {
    it('should return counts by category', () => {
      const summary = getErrorSummary(userId);
      expect(summary.length).toBeGreaterThan(0);
      for (const s of summary) {
        expect(s.count).toBeGreaterThan(0);
        expect(['grammar', 'vocab', 'conjugation', 'pronunciation', 'syntax', 'other']).toContain(s.category);
      }
    });

    it('should be ordered by count descending', () => {
      const summary = getErrorSummary(userId);
      for (let i = 1; i < summary.length; i++) {
        expect(summary[i - 1].count).toBeGreaterThanOrEqual(summary[i].count);
      }
    });
  });

  describe('getTotalErrorCount', () => {
    it('should return total error count', () => {
      const count = getTotalErrorCount(userId);
      expect(count).toBeGreaterThanOrEqual(5); // We logged at least 5 above
    });

    it('should return 0 for user with no errors', () => {
      expect(getTotalErrorCount(99999)).toBe(0);
    });
  });
});
