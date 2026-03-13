import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { seedDefaultSettings, _clearCache } from '../../src/services/settings';
import { buildAdminSystemPrompt } from '../../src/services/adminAgent';

const TEST_DB_PATH = './data/test-admin-agent.db';

describe('Admin Agent', () => {
  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });
    seedDefaultSettings();

    // Create a test user
    const db = getDb();
    db.run(`INSERT INTO users (slack_user_id, display_name, level, xp, streak_days) VALUES ('U_AGENT', 'Agent User', 2, 200, 3)`);
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('buildAdminSystemPrompt', () => {
    it('should include static briefing', () => {
      const prompt = buildAdminSystemPrompt();
      expect(prompt).toContain('admin agent for Gringo');
      expect(prompt).toContain('#charla-libre');
      expect(prompt).toContain('SM-2');
      expect(prompt).toContain('srs.min_ease_factor');
    });

    it('should include current settings', () => {
      const prompt = buildAdminSystemPrompt();
      expect(prompt).toContain('Settings');
      expect(prompt).toContain('xp.text_message');
      expect(prompt).toContain('srs.max_cards_per_session');
    });

    it('should include user list', () => {
      const prompt = buildAdminSystemPrompt();
      expect(prompt).toContain('Users');
      expect(prompt).toContain('Agent User');
      expect(prompt).toContain('level 2');
    });

    it('should include constraint warnings', () => {
      const prompt = buildAdminSystemPrompt();
      expect(prompt).toContain('Never set below 1.0');
      expect(prompt).toContain('Keep low');
    });

    it('should include charla behavior instructions', () => {
      const prompt = buildAdminSystemPrompt();
      expect(prompt).toContain('conversation partner');
      expect(prompt).toContain('voseo');
      expect(prompt).toContain('lunfardo');
    });

    it('should include admin user context when userId provided', () => {
      const db = getDb();
      const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_AGENT'`);
      const userId = result[0].values[0][0] as number;

      const prompt = buildAdminSystemPrompt(userId);
      expect(prompt).toContain('You are chatting with');
      expect(prompt).toContain('Agent User');
      expect(prompt).toContain('Level: 2');
    });

    it('should work without userId (slash command mode)', () => {
      const prompt = buildAdminSystemPrompt();
      expect(prompt).not.toContain('You are chatting with');
    });
  });
});
