/**
 * User Service — CRUD + streak/XP/level management.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const userLog = log.withScope('user');

// ── Types ───────────────────────────────────────────────────

export interface User {
  id: number;
  slackUserId: string;
  displayName: string | null;
  level: number;
  xp: number;
  streakDays: number;
  lastPracticeAt: string | null;
  preferredDifficulty: 'easy' | 'normal' | 'hard';
  timezone: string;
  notificationPrefs: string;
  onboarded: boolean;
  createdAt: string;
}

export interface NotificationPrefs {
  srsReminders: boolean;
  dailyLessons: boolean;
  quietStart?: string; // "22:00"
  quietEnd?: string;   // "08:00"
}

// ── CRUD ────────────────────────────────────────────────────

export function getOrCreateUser(slackUserId: string, displayName?: string): User {
  const db = getDb();

  const existing = db.exec(
    `SELECT * FROM users WHERE slack_user_id = '${esc(slackUserId)}'`,
  );
  if (existing.length && existing[0].values.length) {
    return rowToUser(existing[0].values[0]);
  }

  db.run(
    `INSERT INTO users (slack_user_id, display_name) VALUES ('${esc(slackUserId)}', ${displayName ? `'${esc(displayName)}'` : 'NULL'})`,
  );

  const result = db.exec(
    `SELECT * FROM users WHERE slack_user_id = '${esc(slackUserId)}'`,
  );
  userLog.info(`New user created: ${slackUserId}`);
  return rowToUser(result[0].values[0]);
}

export function getUserById(id: number): User | null {
  const db = getDb();
  const result = db.exec(`SELECT * FROM users WHERE id = ${id}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToUser(result[0].values[0]);
}

export function getUserBySlackId(slackUserId: string): User | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM users WHERE slack_user_id = '${esc(slackUserId)}'`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToUser(result[0].values[0]);
}

export function getAllUsers(): User[] {
  const db = getDb();
  const result = db.exec('SELECT * FROM users ORDER BY created_at ASC');
  if (!result.length) return [];
  return result[0].values.map(rowToUser);
}

// ── Level ───────────────────────────────────────────────────

export function updateLevel(userId: number, newLevel: number): void {
  if (newLevel < 1 || newLevel > 5) throw new Error(`Level must be 1-5, got ${newLevel}`);
  const db = getDb();
  db.run(`UPDATE users SET level = ${newLevel}, updated_at = datetime('now') WHERE id = ${userId}`);
  userLog.info(`User ${userId} level → ${newLevel}`);
}

// ── XP ──────────────────────────────────────────────────────

/**
 * XP thresholds per level. Reaching the threshold levels up automatically.
 * Hardcoded defaults — at runtime, prefer getXpThresholds() from settings.
 */
export const XP_THRESHOLDS: Record<number, number> = {
  1: 100,
  2: 300,
  3: 600,
  4: 1000,
  5: Infinity, // Max level
};

/**
 * Get XP thresholds from settings if available, otherwise use hardcoded defaults.
 */
function getActiveThresholds(): Record<number, number> {
  try {
    const { getXpThresholds } = require('./settings');
    return getXpThresholds();
  } catch {
    return XP_THRESHOLDS;
  }
}

export function addXp(userId: number, amount: number): { newXp: number; leveledUp: boolean } {
  const user = getUserById(userId);
  if (!user) throw new Error(`User ${userId} not found`);

  const newXp = user.xp + amount;
  const db = getDb();
  db.run(`UPDATE users SET xp = ${newXp}, updated_at = datetime('now') WHERE id = ${userId}`);

  // Check level up
  const thresholds = getActiveThresholds();
  const threshold = thresholds[user.level] ?? Infinity;
  if (newXp >= threshold && user.level < 5) {
    const newLevel = user.level + 1;
    db.run(`UPDATE users SET level = ${newLevel} WHERE id = ${userId}`);
    userLog.info(`User ${userId} leveled up! ${user.level} → ${newLevel} (${newXp} XP)`);
    return { newXp, leveledUp: true };
  }

  return { newXp, leveledUp: false };
}

// ── Streak ──────────────────────────────────────────────────

/**
 * Update user's practice streak.
 *
 * Rules:
 *  - If last_practice_at was yesterday → increment streak
 *  - If last_practice_at is today → no-op (already counted)
 *  - If last_practice_at is older or null → reset to 1
 *
 * Uses the user's timezone for date comparison.
 */
export function updateStreak(userId: number, now?: Date): { streakDays: number; isNewDay: boolean } {
  const user = getUserById(userId);
  if (!user) throw new Error(`User ${userId} not found`);

  const currentDate = now ?? new Date();
  const todayStr = dateToLocalString(currentDate, user.timezone);

  if (!user.lastPracticeAt) {
    // First ever practice
    setStreak(userId, 1, currentDate.toISOString());
    return { streakDays: 1, isNewDay: true };
  }

  // Parse stored ISO datetime
  const storedDate = new Date(user.lastPracticeAt.endsWith('Z') ? user.lastPracticeAt : user.lastPracticeAt + 'Z');
  const lastDate = dateToLocalString(storedDate, user.timezone);

  if (lastDate === todayStr) {
    // Already practiced today
    return { streakDays: user.streakDays, isNewDay: false };
  }

  // Check if yesterday
  const yesterday = new Date(currentDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateToLocalString(yesterday, user.timezone);

  if (lastDate === yesterdayStr) {
    // Consecutive day
    const newStreak = user.streakDays + 1;
    setStreak(userId, newStreak, currentDate.toISOString());
    return { streakDays: newStreak, isNewDay: true };
  }

  // Streak broken — reset
  setStreak(userId, 1, currentDate.toISOString());
  return { streakDays: 1, isNewDay: true };
}

function setStreak(userId: number, streakDays: number, practiceDate: string): void {
  const db = getDb();
  db.run(
    `UPDATE users SET streak_days = ${streakDays}, last_practice_at = '${practiceDate}', updated_at = datetime('now') WHERE id = ${userId}`,
  );
}

// ── Onboarding ─────────────────────────────────────────────

export function markOnboarded(userId: number): void {
  const db = getDb();
  db.run(`UPDATE users SET onboarded = 1, updated_at = datetime('now') WHERE id = ${userId}`);
  userLog.info(`User ${userId} marked as onboarded`);
}

// ── Helpers ─────────────────────────────────────────────────

function dateToLocalString(date: Date, timezone: string): string {
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
  } catch {
    // Fallback if timezone is invalid
    return date.toISOString().slice(0, 10);
  }
}

function rowToUser(row: unknown[]): User {
  return {
    id: row[0] as number,
    slackUserId: row[1] as string,
    displayName: row[2] as string | null,
    level: row[3] as number,
    xp: row[4] as number,
    streakDays: row[5] as number,
    lastPracticeAt: row[6] as string | null,
    preferredDifficulty: row[7] as User['preferredDifficulty'],
    timezone: row[8] as string,
    notificationPrefs: (row[9] as string) ?? '{}',
    onboarded: !!(row[10] as number),
    createdAt: row[11] as string,
  };
}

// ── Notification Prefs ──────────────────────────────────────

function defaultPrefs(): NotificationPrefs {
  return { srsReminders: true, dailyLessons: true };
}

export function getNotificationPrefs(userId: number): NotificationPrefs {
  const user = getUserById(userId);
  if (!user) return defaultPrefs();
  try {
    return { ...defaultPrefs(), ...JSON.parse(user.notificationPrefs ?? '{}') };
  } catch {
    return defaultPrefs();
  }
}

export function setNotificationPrefs(userId: number, prefs: NotificationPrefs): void {
  const db = getDb();
  db.run(
    `UPDATE users SET notification_prefs = '${esc(JSON.stringify(prefs))}', updated_at = datetime('now') WHERE id = ${userId}`,
  );
  userLog.info(`User ${userId} notification prefs updated: ${JSON.stringify(prefs)}`);
}

// ── Helpers ─────────────────────────────────────────────────

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
