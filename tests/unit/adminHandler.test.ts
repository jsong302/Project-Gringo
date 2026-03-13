import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDb, closeDb } from '../../src/db';
import { seedDefaultSettings, setSetting, _clearCache } from '../../src/services/settings';
import { handleAdmin, _clearAllHistory, clearAdminHistory } from '../../src/handlers/adminHandler';

const TEST_DB_PATH = './data/test-admin-handler.db';

describe('Admin Handler', () => {
  let responses: any[];
  const mockRespond = async (msg: any) => { responses.push(msg); };

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });
    seedDefaultSettings();
    _clearCache();
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(() => {
    responses = [];
    _clearAllHistory();
    _clearCache();
  });

  describe('auth check', () => {
    it('should reject non-admin users', async () => {
      await handleAdmin('U_NOBODY', 'show users', mockRespond);
      expect(responses[0].text).toContain('don\'t have admin permissions');
    });
  });

  describe('special commands', () => {
    it('should show help for empty message', async () => {
      setSetting('admin.user_ids', ['U_BOSS']);
      _clearCache();
      await handleAdmin('U_BOSS', '', mockRespond);
      expect(responses[0].text).toContain('Admin Agent');
    });

    it('should show help for "help"', async () => {
      setSetting('admin.user_ids', ['U_BOSS']);
      _clearCache();
      await handleAdmin('U_BOSS', 'help', mockRespond);
      expect(responses[0].text).toContain('Admin Agent');
    });

    it('should clear history', async () => {
      setSetting('admin.user_ids', ['U_BOSS']);
      _clearCache();
      await handleAdmin('U_BOSS', 'clear', mockRespond);
      expect(responses[0].text).toContain('cleared');
    });
  });

  describe('clearAdminHistory', () => {
    it('should clear history for specific user', () => {
      // Just ensure it doesn't throw
      clearAdminHistory('U_WHOEVER');
    });
  });
});
