import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { executeTool, ADMIN_TOOL_DEFINITIONS } from '../../src/services/adminTools';
import { setSetting, seedDefaultSettings, _clearCache } from '../../src/services/settings';
import { seedVocabulary, seedConjugations, seedPhrases, seedVesre } from '../../src/services/seedContent';
import { createCardsForUser } from '../../src/services/srsRepository';
import { logLearningError } from '../../src/services/errorTracker';
import { upsertPrompt } from '../../src/services/prompts';

const TEST_DB_PATH = './data/test-admin-tools.db';

describe('Admin Tools', () => {
  let userId: number;

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });

    seedDefaultSettings();

    // Create test user
    const db = getDb();
    db.run(`INSERT INTO users (slack_user_id, display_name, level, xp, streak_days) VALUES ('U_ADMIN_TEST', 'Admin Test', 3, 450, 10)`);
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_ADMIN_TEST'`);
    userId = result[0].values[0][0] as number;

    // Seed content and create cards
    seedVocabulary();
    createCardsForUser(userId, [
      { cardType: 'vocab', contentId: 1 },
      { cardType: 'vocab', contentId: 2 },
      { cardType: 'vocab', contentId: 3 },
    ]);

    // Log some errors
    logLearningError(userId, 'conjugation', 'Used tú instead of vos', 'tu hablas', 'vos hablás', 'voice');
    logLearningError(userId, 'grammar', 'Missing accent', 'como estas', 'cómo estás', 'text');

    // Seed a prompt
    upsertPrompt('test_prompt', 'Hello {{name}}', 'Test prompt');
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('tool definitions', () => {
    it('should have all expected tools', () => {
      const names = ADMIN_TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toContain('list_settings');
      expect(names).toContain('get_setting');
      expect(names).toContain('update_setting');
      expect(names).toContain('list_users');
      expect(names).toContain('get_user_detail');
      expect(names).toContain('update_user_level');
      expect(names).toContain('get_error_trends');
      expect(names).toContain('get_user_errors');
      expect(names).toContain('get_srs_health');
      expect(names).toContain('list_prompts');
      expect(names).toContain('get_prompt');
      expect(names).toContain('update_prompt');
      expect(names).toContain('manage_admins');
    });

    it('should have valid input schemas', () => {
      for (const tool of ADMIN_TOOL_DEFINITIONS) {
        expect(tool.input_schema).toBeDefined();
        expect(tool.input_schema.type).toBe('object');
        expect(tool.description).toBeTruthy();
      }
    });
  });

  describe('list_settings', () => {
    it('should return all settings as JSON', () => {
      const result = JSON.parse(executeTool('list_settings', {}));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].key).toBeTruthy();
    });
  });

  describe('get_setting', () => {
    it('should return a specific setting', () => {
      const result = JSON.parse(executeTool('get_setting', { key: 'srs.max_cards_per_session' }));
      expect(result.key).toBe('srs.max_cards_per_session');
      expect(result.value).toBe(10);
    });

    it('should return error for non-existent setting', () => {
      const result = JSON.parse(executeTool('get_setting', { key: 'nonexistent' }));
      expect(result.error).toContain('not found');
    });
  });

  describe('update_setting', () => {
    it('should update a setting', () => {
      _clearCache();
      const result = JSON.parse(executeTool('update_setting', {
        key: 'srs.max_cards_per_session',
        value: 15,
        reason: 'Testing update',
      }));
      expect(result.success).toBe(true);

      const check = JSON.parse(executeTool('get_setting', { key: 'srs.max_cards_per_session' }));
      expect(check.value).toBe(15);

      // Restore
      executeTool('update_setting', { key: 'srs.max_cards_per_session', value: 10 });
    });
  });

  describe('list_users', () => {
    it('should return users with stats', () => {
      const result = JSON.parse(executeTool('list_users', {}));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      const user = result.find((u: any) => u.slackUserId === 'U_ADMIN_TEST');
      expect(user).toBeDefined();
      expect(user.level).toBe(3);
      expect(user.cards.total).toBe(3);
    });
  });

  describe('get_user_detail', () => {
    it('should return detailed user info', () => {
      const result = JSON.parse(executeTool('get_user_detail', { user_id: userId }));
      expect(result.user.level).toBe(3);
      expect(result.user.xp).toBe(450);
      expect(result.srs.total).toBe(3);
      expect(result.totalErrors).toBeGreaterThan(0);
      expect(result.recentErrors.length).toBeGreaterThan(0);
    });

    it('should return error for non-existent user', () => {
      const result = JSON.parse(executeTool('get_user_detail', { user_id: 99999 }));
      expect(result.error).toContain('not found');
    });
  });

  describe('update_user_level', () => {
    it('should update user level', () => {
      const result = JSON.parse(executeTool('update_user_level', { user_id: userId, level: 4 }));
      expect(result.success).toBe(true);
      expect(result.previousLevel).toBe(3);
      expect(result.newLevel).toBe(4);

      // Restore
      executeTool('update_user_level', { user_id: userId, level: 3 });
    });

    it('should reject invalid level', () => {
      const result = JSON.parse(executeTool('update_user_level', { user_id: userId, level: 6 }));
      expect(result.error).toContain('1-5');
    });
  });

  describe('get_error_trends', () => {
    it('should return error trends across users', () => {
      const result = JSON.parse(executeTool('get_error_trends', {}));
      expect(result.totalErrors).toBeGreaterThan(0);
      expect(result.byCategory).toBeDefined();
      expect(result.recentErrors.length).toBeGreaterThan(0);
    });
  });

  describe('get_user_errors', () => {
    it('should return errors for a user', () => {
      const result = JSON.parse(executeTool('get_user_errors', { user_id: userId }));
      expect(result.totalErrors).toBeGreaterThan(0);
      expect(result.recentErrors.length).toBeGreaterThan(0);
    });
  });

  describe('get_srs_health', () => {
    it('should return SRS health metrics', () => {
      const result = JSON.parse(executeTool('get_srs_health', {}));
      expect(result.totalCards).toBeGreaterThan(0);
      expect(result.userCount).toBeGreaterThan(0);
      expect(result.perUser.length).toBeGreaterThan(0);
    });
  });

  describe('list_prompts', () => {
    it('should return prompts with previews', () => {
      const result = JSON.parse(executeTool('list_prompts', {}));
      expect(Array.isArray(result)).toBe(true);
      const testPrompt = result.find((p: any) => p.name === 'test_prompt');
      expect(testPrompt).toBeDefined();
      expect(testPrompt.textPreview).toContain('Hello');
    });
  });

  describe('get_prompt', () => {
    it('should return full prompt text', () => {
      const result = JSON.parse(executeTool('get_prompt', { name: 'test_prompt' }));
      expect(result.promptText).toBe('Hello {{name}}');
    });

    it('should return error for non-existent prompt', () => {
      const result = JSON.parse(executeTool('get_prompt', { name: 'nope' }));
      expect(result.error).toContain('not found');
    });
  });

  describe('update_prompt', () => {
    it('should update prompt text', () => {
      const result = JSON.parse(executeTool('update_prompt', {
        name: 'test_prompt',
        prompt_text: 'Updated {{name}}!',
      }));
      expect(result.success).toBe(true);

      const check = JSON.parse(executeTool('get_prompt', { name: 'test_prompt' }));
      expect(check.promptText).toBe('Updated {{name}}!');
    });
  });

  describe('manage_admins', () => {
    it('should list admins (initially empty)', () => {
      const result = JSON.parse(executeTool('manage_admins', { action: 'list' }));
      expect(result.admins).toBeDefined();
    });

    it('should add an admin', () => {
      const result = JSON.parse(executeTool('manage_admins', { action: 'add', slack_user_id: 'U_NEW_ADMIN' }));
      expect(result.success).toBe(true);
      expect(result.admins).toContain('U_NEW_ADMIN');
    });

    it('should not add duplicate admin', () => {
      const result = JSON.parse(executeTool('manage_admins', { action: 'add', slack_user_id: 'U_NEW_ADMIN' }));
      expect(result.error).toContain('already an admin');
    });

    it('should remove an admin when there are multiple', () => {
      // Add a second admin first
      executeTool('manage_admins', { action: 'add', slack_user_id: 'U_SECOND' });
      const result = JSON.parse(executeTool('manage_admins', { action: 'remove', slack_user_id: 'U_NEW_ADMIN' }));
      expect(result.success).toBe(true);
      expect(result.admins).not.toContain('U_NEW_ADMIN');
    });

    it('should not remove last admin', () => {
      const result = JSON.parse(executeTool('manage_admins', { action: 'remove', slack_user_id: 'U_SECOND' }));
      // U_SECOND is the only one left
      expect(result.error).toContain('last admin');
    });
  });

  describe('log_learning_error', () => {
    it('should log a learning error for the user', () => {
      const result = JSON.parse(executeTool('log_learning_error', {
        user_id: userId,
        category: 'conjugation',
        description: 'Used hablas instead of hablás',
        user_said: 'tu hablas',
        correction: 'vos hablás',
      }));
      expect(result.success).toBe(true);
      expect(result.errorId).toBeGreaterThan(0);
    });
  });

  describe('get_learner_context', () => {
    it('should return learner context for a user', () => {
      const result = JSON.parse(executeTool('get_learner_context', { user_id: userId }));
      expect(result.level).toBe(3);
      expect(result.srs).toBeDefined();
      expect(result.topErrors).toBeDefined();
    });

    it('should return error for non-existent user', () => {
      const result = JSON.parse(executeTool('get_learner_context', { user_id: 99999 }));
      expect(result.error).toContain('not found');
    });
  });

  describe('award_xp', () => {
    it('should award XP to a user', () => {
      const result = JSON.parse(executeTool('award_xp', { user_id: userId, amount: 10 }));
      expect(result.success).toBe(true);
      expect(result.newXp).toBe(result.previousXp + 10);
    });
  });

  describe('unknown tool', () => {
    it('should return error for unknown tool', () => {
      const result = JSON.parse(executeTool('nonexistent_tool', {}));
      expect(result.error).toContain('Unknown tool');
    });
  });
});
