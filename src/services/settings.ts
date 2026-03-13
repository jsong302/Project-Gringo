/**
 * System Settings — DB-backed key-value config store.
 *
 * All tunable parameters live here instead of being hardcoded.
 * Values are stored as JSON strings and parsed on read.
 * The admin agent (or admin commands) can modify these at runtime.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const settingsLog = log.withScope('settings');

// ── In-memory cache ─────────────────────────────────────────
// Settings are read frequently, so we cache them.
// Cache is invalidated on write.

const cache = new Map<string, unknown>();
let cacheLoaded = false;

function loadCache(): void {
  if (cacheLoaded) return;
  const db = getDb();
  const result = db.exec('SELECT key, value FROM system_settings');
  if (result.length) {
    for (const row of result[0].values) {
      const key = row[0] as string;
      const raw = row[1] as string;
      try {
        cache.set(key, JSON.parse(raw));
      } catch {
        cache.set(key, raw);
      }
    }
  }
  cacheLoaded = true;
}

// ── Core CRUD ───────────────────────────────────────────────

/**
 * Get a setting value. Returns the default if not found.
 */
export function getSetting<T>(key: string, defaultValue: T): T {
  loadCache();
  if (cache.has(key)) return cache.get(key) as T;
  return defaultValue;
}

/**
 * Get a setting or throw if not found.
 */
export function getSettingOrThrow<T>(key: string): T {
  loadCache();
  if (!cache.has(key)) throw new Error(`Setting not found: "${key}"`);
  return cache.get(key) as T;
}

/**
 * Set a setting value. Creates or updates.
 */
export function setSetting(key: string, value: unknown, description?: string, updatedBy?: string): void {
  const db = getDb();
  const jsonValue = JSON.stringify(value);

  db.run(
    `INSERT INTO system_settings (key, value, description, updated_by)
     VALUES ('${esc(key)}', '${esc(jsonValue)}', ${description ? `'${esc(description)}'` : 'NULL'}, ${updatedBy ? `'${esc(updatedBy)}'` : 'NULL'})
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       description = COALESCE(excluded.description, system_settings.description),
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  );

  // Update cache
  cache.set(key, value);
  settingsLog.debug(`Setting updated: ${key}`);
}

/**
 * Delete a setting.
 */
export function deleteSetting(key: string): boolean {
  const db = getDb();
  const exists = db.exec(`SELECT 1 FROM system_settings WHERE key = '${esc(key)}'`);
  if (!exists.length || !exists[0].values.length) return false;

  db.run(`DELETE FROM system_settings WHERE key = '${esc(key)}'`);
  cache.delete(key);
  settingsLog.debug(`Setting deleted: ${key}`);
  return true;
}

/**
 * List all settings.
 */
export interface SettingEntry {
  key: string;
  value: unknown;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export function listSettings(): SettingEntry[] {
  const db = getDb();
  const result = db.exec('SELECT key, value, description, updated_by, updated_at FROM system_settings ORDER BY key');
  if (!result.length) return [];

  return result[0].values.map((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row[1] as string);
    } catch {
      parsed = row[1];
    }
    return {
      key: row[0] as string,
      value: parsed,
      description: row[2] as string | null,
      updatedBy: row[3] as string | null,
      updatedAt: row[4] as string,
    };
  });
}

// ── Seed defaults ───────────────────────────────────────────

export function seedDefaultSettings(): void {
  for (const s of DEFAULT_SETTINGS) {
    const db = getDb();
    const exists = db.exec(`SELECT 1 FROM system_settings WHERE key = '${esc(s.key)}'`);
    if (exists.length && exists[0].values.length) continue;
    setSetting(s.key, s.value, s.description);
  }
  settingsLog.info(`Seeded ${DEFAULT_SETTINGS.length} default settings (skipped existing)`);
}

// ── Default settings ────────────────────────────────────────

export const DEFAULT_SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  // XP
  { key: 'xp.text_message', value: 5, description: 'XP earned per text message in charla' },
  { key: 'xp.voice_memo', value: 10, description: 'XP earned per voice memo' },
  { key: 'xp.review_correct', value: 3, description: 'XP earned per correct SRS review' },
  { key: 'xp.review_incorrect', value: 1, description: 'XP earned per incorrect SRS review (participation)' },
  { key: 'xp.thresholds', value: { 1: 100, 2: 300, 3: 600, 4: 1000, 5: Infinity }, description: 'XP needed per level to level up' },

  // SRS
  { key: 'srs.default_ease_factor', value: 2.5, description: 'SM-2 default ease factor for new cards' },
  { key: 'srs.first_interval', value: 1, description: 'SM-2 first interval in days' },
  { key: 'srs.second_interval', value: 6, description: 'SM-2 second interval in days' },
  { key: 'srs.max_cards_per_session', value: 10, description: 'Maximum cards shown per review session' },
  { key: 'srs.min_ease_factor', value: 1.3, description: 'SM-2 minimum ease factor' },

  // LLM
  { key: 'llm.timeout_ms', value: 30000, description: 'LLM request timeout in milliseconds' },
  { key: 'llm.max_retries', value: 2, description: 'Max LLM retry attempts' },
  { key: 'llm.charla_temperature', value: 0.8, description: 'Temperature for charla conversations' },
  { key: 'llm.grading_temperature', value: 0.3, description: 'Temperature for grading responses' },
  { key: 'llm.charla_max_tokens', value: 512, description: 'Max tokens for charla responses' },

  // Cron
  { key: 'cron.daily_lesson', value: '0 9 * * 1-5', description: 'Cron schedule for daily lessons (default: 9am Mon-Fri)' },
  { key: 'cron.lunfardo_del_dia', value: '0 12 * * *', description: 'Cron schedule for lunfardo del dia (default: noon daily)' },

  // Content gating
  { key: 'content.level_gate', value: true, description: 'Gate seed content by user level (only show level-appropriate cards)' },
  { key: 'content.new_cards_per_day', value: 5, description: 'Max new SRS cards introduced per user per day' },

  // Channels
  { key: 'channels.charla', value: '', description: 'Slack channel ID for charla (empty = DMs + @mentions anywhere)' },
  { key: 'channels.lessons', value: '', description: 'Slack channel ID for #daily-lesson' },
  { key: 'channels.lunfardo', value: '', description: 'Slack channel ID for #lunfardo-del-dia' },
  { key: 'channels.repaso', value: '', description: 'Slack channel ID for repaso (empty = DMs only via /gringo repaso)' },
  { key: 'channels.admin', value: '', description: 'Slack channel ID for admin-only channel' },

  // Admin
  { key: 'admin.user_ids', value: [], description: 'Slack user IDs with admin access (JSON array)' },

  // Thread
  { key: 'thread.max_history_messages', value: 20, description: 'Max messages loaded from DB for thread context' },

  // Memory
  { key: 'memory.regenerate_after_interactions', value: 20, description: 'Regenerate user memory after this many new interactions' },
];

// ── Typed getters (convenience) ─────────────────────────────

export function getXpForTextMessage(): number {
  return getSetting('xp.text_message', 5);
}

export function getXpForVoiceMemo(): number {
  return getSetting('xp.voice_memo', 10);
}

export function getXpThresholds(): Record<number, number> {
  return getSetting('xp.thresholds', { 1: 100, 2: 300, 3: 600, 4: 1000, 5: Infinity });
}

export function getMaxCardsPerSession(): number {
  return getSetting('srs.max_cards_per_session', 10);
}

export function getCharlaTemperature(): number {
  return getSetting('llm.charla_temperature', 0.8);
}

export function getGradingTemperature(): number {
  return getSetting('llm.grading_temperature', 0.3);
}

export function getAdminUserIds(): string[] {
  return getSetting('admin.user_ids', []);
}

export function isAdmin(slackUserId: string): boolean {
  const admins = getAdminUserIds();
  return admins.includes(slackUserId);
}

export function getChannelConfig(purpose: string): string {
  return getSetting(`channels.${purpose}`, '');
}

// ── Test helper ─────────────────────────────────────────────

/** @internal — test-only: clear the in-memory cache */
export function _clearCache(): void {
  cache.clear();
  cacheLoaded = false;
}

// ── Helpers ─────────────────────────────────────────────────

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
