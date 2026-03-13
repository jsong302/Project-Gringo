import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import {
  getSetting,
  getSettingOrThrow,
  setSetting,
  deleteSetting,
  listSettings,
  seedDefaultSettings,
  getXpForTextMessage,
  getXpForVoiceMemo,
  getXpThresholds,
  getMaxCardsPerSession,
  isAdmin,
  getChannelConfig,
  DEFAULT_SETTINGS,
  _clearCache,
} from '../../src/services/settings';

const TEST_DB_PATH = './data/test-settings.db';

describe('System Settings', () => {
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

  beforeEach(() => {
    _clearCache();
  });

  describe('getSetting / setSetting', () => {
    it('should return default when setting does not exist', () => {
      expect(getSetting('nonexistent', 42)).toBe(42);
    });

    it('should set and get a number', () => {
      setSetting('test.number', 100);
      expect(getSetting('test.number', 0)).toBe(100);
    });

    it('should set and get a string', () => {
      setSetting('test.string', 'hello');
      expect(getSetting('test.string', '')).toBe('hello');
    });

    it('should set and get a boolean', () => {
      setSetting('test.bool', true);
      expect(getSetting('test.bool', false)).toBe(true);
    });

    it('should set and get an object', () => {
      setSetting('test.obj', { a: 1, b: 'two' });
      const val = getSetting<Record<string, unknown>>('test.obj', {});
      expect(val.a).toBe(1);
      expect(val.b).toBe('two');
    });

    it('should set and get an array', () => {
      setSetting('test.arr', ['U123', 'U456']);
      const val = getSetting<string[]>('test.arr', []);
      expect(val).toEqual(['U123', 'U456']);
    });

    it('should update existing setting', () => {
      setSetting('test.update', 1);
      expect(getSetting('test.update', 0)).toBe(1);

      setSetting('test.update', 2);
      expect(getSetting('test.update', 0)).toBe(2);
    });

    it('should store description', () => {
      setSetting('test.desc', 'val', 'A description');
      const all = listSettings();
      const found = all.find((s) => s.key === 'test.desc');
      expect(found?.description).toBe('A description');
    });

    it('should store updatedBy', () => {
      setSetting('test.by', 'val', 'desc', 'U_ADMIN');
      const all = listSettings();
      const found = all.find((s) => s.key === 'test.by');
      expect(found?.updatedBy).toBe('U_ADMIN');
    });
  });

  describe('getSettingOrThrow', () => {
    it('should return value when setting exists', () => {
      setSetting('test.exists', 'yes');
      expect(getSettingOrThrow('test.exists')).toBe('yes');
    });

    it('should throw when setting does not exist', () => {
      expect(() => getSettingOrThrow('nope.nope')).toThrow('Setting not found');
    });
  });

  describe('deleteSetting', () => {
    it('should delete an existing setting', () => {
      setSetting('test.delete', 'bye');
      expect(deleteSetting('test.delete')).toBe(true);
      expect(getSetting('test.delete', 'gone')).toBe('gone');
    });

    it('should return false for non-existent setting', () => {
      expect(deleteSetting('nonexistent.key')).toBe(false);
    });
  });

  describe('listSettings', () => {
    it('should list all settings', () => {
      const all = listSettings();
      expect(all.length).toBeGreaterThan(0);
      for (const s of all) {
        expect(s.key).toBeTruthy();
        expect(s.updatedAt).toBeTruthy();
      }
    });

    it('should parse JSON values', () => {
      setSetting('test.parsed', { x: 1 });
      const all = listSettings();
      const found = all.find((s) => s.key === 'test.parsed');
      expect(found?.value).toEqual({ x: 1 });
    });
  });

  describe('seedDefaultSettings', () => {
    it('should seed all default settings', () => {
      // Delete all test.* keys first to not pollute count
      seedDefaultSettings();
      const all = listSettings();
      const defaultKeys = DEFAULT_SETTINGS.map((s) => s.key);
      for (const key of defaultKeys) {
        expect(all.find((s) => s.key === key)).toBeDefined();
      }
    });

    it('should not overwrite existing settings', () => {
      setSetting('xp.text_message', 999);
      seedDefaultSettings();
      expect(getSetting('xp.text_message', 0)).toBe(999);
    });

    it('should define a reasonable number of defaults', () => {
      expect(DEFAULT_SETTINGS.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('typed getters', () => {
    it('getXpForTextMessage should return number', () => {
      expect(typeof getXpForTextMessage()).toBe('number');
    });

    it('getXpForVoiceMemo should return number', () => {
      expect(typeof getXpForVoiceMemo()).toBe('number');
    });

    it('getXpThresholds should return object with level keys', () => {
      const t = getXpThresholds();
      expect(t[1]).toBeDefined();
      expect(t[2]).toBeDefined();
    });

    it('getMaxCardsPerSession should return number', () => {
      expect(typeof getMaxCardsPerSession()).toBe('number');
      expect(getMaxCardsPerSession()).toBeGreaterThan(0);
    });

    it('isAdmin should return false for non-admin', () => {
      expect(isAdmin('U_RANDOM')).toBe(false);
    });

    it('isAdmin should return true for admin', () => {
      setSetting('admin.user_ids', ['U_BOSS']);
      _clearCache();
      expect(isAdmin('U_BOSS')).toBe(true);
    });

    it('getChannelConfig should return empty string by default', () => {
      expect(getChannelConfig('charla')).toBe('');
    });
  });

  describe('cache behavior', () => {
    it('should serve from cache on second read', () => {
      setSetting('test.cache', 'cached');
      // First read loads cache
      expect(getSetting('test.cache', '')).toBe('cached');
      // Modify DB directly (bypass cache)
      const db = getDb();
      db.run(`UPDATE system_settings SET value = '"modified"' WHERE key = 'test.cache'`);
      // Should still return cached value
      expect(getSetting('test.cache', '')).toBe('cached');
      // Clear cache and re-read
      _clearCache();
      expect(getSetting('test.cache', '')).toBe('modified');
    });

    it('should update cache on setSetting', () => {
      setSetting('test.live', 'v1');
      expect(getSetting('test.live', '')).toBe('v1');
      setSetting('test.live', 'v2');
      expect(getSetting('test.live', '')).toBe('v2');
    });
  });
});
