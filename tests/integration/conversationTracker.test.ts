import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import {
  startConversation,
  getConversationById,
  getConversationByThread,
  getActiveConversation,
  addTurn,
  endConversation,
  abandonConversation,
  getUserConversationHistory,
} from '../../src/services/conversationTracker';

const TEST_DB_PATH = './data/test-conv-tracker.db';

describe('Conversation Tracker', () => {
  let userId: number;

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });

    const db = getDb();
    db.run(`INSERT INTO users (slack_user_id, display_name) VALUES ('U_CONV', 'Conv User')`);
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_CONV'`);
    userId = result[0].values[0][0] as number;
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('startConversation', () => {
    it('should create a new conversation', () => {
      const conv = startConversation(userId, 'C_CHARLA', '1234.0001', 'charla');
      expect(conv.id).toBeGreaterThan(0);
      expect(conv.userId).toBe(userId);
      expect(conv.threadType).toBe('charla');
      expect(conv.status).toBe('active');
      expect(conv.turnCount).toBe(0);
    });

    it('should create with scenario', () => {
      const conv = startConversation(userId, 'C_DESAFIO', '1234.0002', 'desafio', 'ordering empanadas');
      expect(conv.scenario).toBe('ordering empanadas');
    });
  });

  describe('getConversationById', () => {
    it('should find by id', () => {
      const created = startConversation(userId, 'C_TEST', '1234.0010', 'charla');
      const found = getConversationById(created.id);
      expect(found).not.toBeNull();
      expect(found!.slackChannelId).toBe('C_TEST');
    });

    it('should return null for missing id', () => {
      expect(getConversationById(99999)).toBeNull();
    });
  });

  describe('getConversationByThread', () => {
    it('should find active conversation by thread', () => {
      startConversation(userId, 'C_THREAD', '9999.0001', 'charla');
      const found = getConversationByThread('C_THREAD', '9999.0001');
      expect(found).not.toBeNull();
      expect(found!.threadType).toBe('charla');
    });

    it('should return null for unknown thread', () => {
      expect(getConversationByThread('C_UNKNOWN', '0000.0000')).toBeNull();
    });
  });

  describe('getActiveConversation', () => {
    it('should find active conversation for user in channel', () => {
      startConversation(userId, 'C_ACTIVE', '5555.0001', 'charla');
      const found = getActiveConversation(userId, 'C_ACTIVE');
      expect(found).not.toBeNull();
    });

    it('should filter by type', () => {
      startConversation(userId, 'C_TYPED', '5555.0002', 'lesson');
      const charla = getActiveConversation(userId, 'C_TYPED', 'charla');
      expect(charla).toBeNull();
      const lesson = getActiveConversation(userId, 'C_TYPED', 'lesson');
      expect(lesson).not.toBeNull();
    });
  });

  describe('addTurn', () => {
    it('should increment turn count', () => {
      const conv = startConversation(userId, 'C_TURN', '6666.0001', 'charla');
      expect(conv.turnCount).toBe(0);

      addTurn(conv.id);
      addTurn(conv.id);
      addTurn(conv.id);

      const updated = getConversationById(conv.id)!;
      expect(updated.turnCount).toBe(3);
    });
  });

  describe('endConversation', () => {
    it('should mark as completed with summary', () => {
      const conv = startConversation(userId, 'C_END', '7777.0001', 'charla');
      endConversation(conv.id, 'Practiced greetings and food vocabulary');

      const updated = getConversationById(conv.id)!;
      expect(updated.status).toBe('completed');
      expect(updated.summary).toContain('greetings');
    });

    it('should no longer appear in active queries', () => {
      const conv = startConversation(userId, 'C_DONE', '7777.0002', 'charla');
      endConversation(conv.id);

      const active = getActiveConversation(userId, 'C_DONE', 'charla');
      expect(active).toBeNull();
    });
  });

  describe('abandonConversation', () => {
    it('should mark as abandoned', () => {
      const conv = startConversation(userId, 'C_ABANDON', '8888.0001', 'charla');
      abandonConversation(conv.id);

      const updated = getConversationById(conv.id)!;
      expect(updated.status).toBe('abandoned');
    });
  });

  describe('getUserConversationHistory', () => {
    it('should return all conversations for user', () => {
      const history = getUserConversationHistory(userId);
      expect(history.length).toBeGreaterThan(0);
    });

    it('should filter by type', () => {
      const charlas = getUserConversationHistory(userId, 'charla');
      for (const c of charlas) {
        expect(c.threadType).toBe('charla');
      }
    });

    it('should respect limit', () => {
      const limited = getUserConversationHistory(userId, undefined, 2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });
  });
});
