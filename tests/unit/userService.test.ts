import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import {
  getOrCreateUser,
  getUserById,
  getUserBySlackId,
  getAllUsers,
  updateLevel,
  addXp,
  updateStreak,
  XP_THRESHOLDS,
} from '../../src/services/userService';

const TEST_DB_PATH = './data/test-user-service.db';

describe('User Service', () => {
  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('getOrCreateUser', () => {
    it('should create a new user', () => {
      const user = getOrCreateUser('U_NEW_1', 'Alice');
      expect(user.id).toBeGreaterThan(0);
      expect(user.slackUserId).toBe('U_NEW_1');
      expect(user.displayName).toBe('Alice');
      expect(user.level).toBe(1);
      expect(user.xp).toBe(0);
      expect(user.streakDays).toBe(0);
    });

    it('should return existing user on duplicate', () => {
      const u1 = getOrCreateUser('U_NEW_1');
      const u2 = getOrCreateUser('U_NEW_1');
      expect(u1.id).toBe(u2.id);
    });

    it('should create user without display name', () => {
      const user = getOrCreateUser('U_NONAME');
      expect(user.displayName).toBeNull();
    });
  });

  describe('getUserById / getUserBySlackId', () => {
    it('should find by id', () => {
      const created = getOrCreateUser('U_FINDME');
      const found = getUserById(created.id);
      expect(found).not.toBeNull();
      expect(found!.slackUserId).toBe('U_FINDME');
    });

    it('should find by slack id', () => {
      getOrCreateUser('U_SLACK_FIND', 'Bob');
      const found = getUserBySlackId('U_SLACK_FIND');
      expect(found).not.toBeNull();
      expect(found!.displayName).toBe('Bob');
    });

    it('should return null for missing user', () => {
      expect(getUserById(99999)).toBeNull();
      expect(getUserBySlackId('U_DOESNT_EXIST')).toBeNull();
    });
  });

  describe('getAllUsers', () => {
    it('should return all users', () => {
      const users = getAllUsers();
      expect(users.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('updateLevel', () => {
    it('should update level', () => {
      const user = getOrCreateUser('U_LEVEL');
      updateLevel(user.id, 3);
      const updated = getUserById(user.id)!;
      expect(updated.level).toBe(3);
    });

    it('should throw for invalid level', () => {
      const user = getOrCreateUser('U_LEVEL');
      expect(() => updateLevel(user.id, 0)).toThrow('Level must be 1-5');
      expect(() => updateLevel(user.id, 6)).toThrow('Level must be 1-5');
    });
  });

  describe('addXp', () => {
    it('should add XP', () => {
      const user = getOrCreateUser('U_XP');
      const result = addXp(user.id, 50);
      expect(result.newXp).toBe(50);
      expect(result.leveledUp).toBe(false);
    });

    it('should level up when threshold reached', () => {
      const user = getOrCreateUser('U_LEVELUP');
      // Level 1 threshold is 100
      addXp(user.id, 99);
      const result = addXp(user.id, 5); // 104 total
      expect(result.newXp).toBe(104);
      expect(result.leveledUp).toBe(true);

      const updated = getUserById(user.id)!;
      expect(updated.level).toBe(2);
    });

    it('should not level past 5', () => {
      const user = getOrCreateUser('U_MAX');
      updateLevel(user.id, 5);
      const db = getDb();
      db.run(`UPDATE users SET xp = 9999 WHERE id = ${user.id}`);
      const result = addXp(user.id, 100);
      expect(result.leveledUp).toBe(false);

      const updated = getUserById(user.id)!;
      expect(updated.level).toBe(5);
    });
  });

  describe('updateStreak', () => {
    it('should start streak at 1 on first practice', () => {
      const user = getOrCreateUser('U_STREAK_NEW');
      const result = updateStreak(user.id);
      expect(result.streakDays).toBe(1);
      expect(result.isNewDay).toBe(true);
    });

    it('should not increment on same day', () => {
      const user = getOrCreateUser('U_STREAK_SAME');
      const now = new Date('2025-07-15T14:00:00Z');
      updateStreak(user.id, now);
      const result = updateStreak(user.id, now);
      expect(result.streakDays).toBe(1);
      expect(result.isNewDay).toBe(false);
    });

    it('should increment on consecutive day', () => {
      const user = getOrCreateUser('U_STREAK_CONSEC');
      const day1 = new Date('2025-07-15T14:00:00Z');
      const day2 = new Date('2025-07-16T14:00:00Z');

      updateStreak(user.id, day1);
      const result = updateStreak(user.id, day2);
      expect(result.streakDays).toBe(2);
      expect(result.isNewDay).toBe(true);
    });

    it('should reset streak after gap', () => {
      const user = getOrCreateUser('U_STREAK_GAP');
      const day1 = new Date('2025-07-15T14:00:00Z');
      const day3 = new Date('2025-07-18T14:00:00Z'); // 3-day gap

      updateStreak(user.id, day1);
      // Manually set streak to 5 to test reset
      const db = getDb();
      db.run(`UPDATE users SET streak_days = 5 WHERE id = ${user.id}`);

      const result = updateStreak(user.id, day3);
      expect(result.streakDays).toBe(1); // Reset
      expect(result.isNewDay).toBe(true);
    });

    it('should build multi-day streak', () => {
      const user = getOrCreateUser('U_STREAK_MULTI');
      const days = [
        new Date('2025-07-10T10:00:00Z'),
        new Date('2025-07-11T10:00:00Z'),
        new Date('2025-07-12T10:00:00Z'),
        new Date('2025-07-13T10:00:00Z'),
      ];

      for (const day of days) {
        updateStreak(user.id, day);
      }

      const updated = getUserById(user.id)!;
      expect(updated.streakDays).toBe(4);
    });
  });
});
