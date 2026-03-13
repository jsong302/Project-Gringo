/**
 * Curriculum Migration — One-time migration for existing users.
 *
 * Maps existing onboarded users to the shared curriculum based on their
 * current level. Runs on boot if curriculum exists but user has no progress rows.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import { getAllUsers } from './userService';
import { getCurriculum, getFirstUnitForLevel } from './curriculum';
import { initializeUserProgress } from './curriculumDelivery';

const migLog = log.withScope('curriculum-migration');

/**
 * Migrate existing onboarded users who don't have curriculum progress yet.
 * Places them based on their current level.
 */
export function migrateExistingUsers(): void {
  const db = getDb();
  const curriculum = getCurriculum();
  if (curriculum.length === 0) return;

  const users = getAllUsers();
  let migrated = 0;

  for (const user of users) {
    if (!user.onboarded) continue;

    // Check if user already has curriculum progress
    const existing = db.exec(
      `SELECT COUNT(*) FROM user_curriculum_progress WHERE user_id = ${user.id}`,
    );
    const count = existing.length ? (existing[0].values[0][0] as number) : 0;
    if (count > 0) continue;

    // Place based on current level
    const startUnit = getFirstUnitForLevel(user.level);
    const unitOrder = startUnit?.unitOrder ?? 1;

    initializeUserProgress(user.id, unitOrder);
    migrated++;
    migLog.info(`Migrated user ${user.id} (level ${user.level}) → unit ${unitOrder}`);
  }

  if (migrated > 0) {
    migLog.info(`Migrated ${migrated} existing user(s) to shared curriculum`);
  }
}
