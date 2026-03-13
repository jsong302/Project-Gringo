/**
 * Curriculum Delivery — progress tracking, unit delivery, exercise grading.
 *
 * Users progress through the shared curriculum via DM. This service handles:
 * - Tracking each user's position in the curriculum
 * - Delivering unit lessons via LLM
 * - Grading exercise responses
 * - Advancing users when they pass
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import { callLlm } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { getCurriculum, getUnit, getUnitByOrder, getCurriculumCount, type CurriculumUnit } from './curriculum';
import { getMemoryForPrompt } from './userMemory';
import { getUserById, updateLevel } from './userService';

const delLog = log.withScope('curriculum-delivery');

// ── Types ───────────────────────────────────────────────────

export interface UserProgress {
  id: number;
  userId: number;
  unitId: number;
  status: 'locked' | 'active' | 'practicing' | 'passed' | 'skipped';
  bestScore: number | null;
  attempts: number;
  startedAt: string | null;
  passedAt: string | null;
}

export interface GradeResult {
  score: number;
  passed: boolean;
  feedback: string;
  errors: string[];
  correction: string;
}

// ── Row mapper ──────────────────────────────────────────────

function rowToProgress(row: any[]): UserProgress {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    unitId: row[2] as number,
    status: row[3] as UserProgress['status'],
    bestScore: row[4] as number | null,
    attempts: row[5] as number,
    startedAt: row[6] as string | null,
    passedAt: row[7] as string | null,
  };
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

// ── Progress queries ────────────────────────────────────────

export function getCurrentUnit(userId: number): { unit: CurriculumUnit; progress: UserProgress } | null {
  const db = getDb();
  // Look for practicing first, then active
  for (const status of ['practicing', 'active']) {
    const result = db.exec(
      `SELECT id, user_id, unit_id, status, best_score, attempts, started_at, passed_at
       FROM user_curriculum_progress
       WHERE user_id = ${userId} AND status = '${status}'
       ORDER BY unit_id ASC LIMIT 1`,
    );
    if (result.length && result[0].values.length) {
      const progress = rowToProgress(result[0].values[0]);
      const unit = getUnit(progress.unitId);
      if (unit) return { unit, progress };
    }
  }
  return null;
}

export function getUserCurriculumProgress(userId: number): {
  currentUnit: CurriculumUnit | null;
  completedCount: number;
  totalCount: number;
  level: number;
} {
  const db = getDb();
  const totalCount = getCurriculumCount();

  const completedResult = db.exec(
    `SELECT COUNT(*) FROM user_curriculum_progress WHERE user_id = ${userId} AND status = 'passed'`,
  );
  const completedCount = completedResult.length ? (completedResult[0].values[0][0] as number) : 0;

  const current = getCurrentUnit(userId);
  const user = getUserById(userId);

  return {
    currentUnit: current?.unit ?? null,
    completedCount,
    totalCount,
    level: user?.level ?? 1,
  };
}

export function getAllUsersProgress(): Array<{
  userId: number;
  displayName: string | null;
  slackUserId: string;
  currentUnit: number | null;
  currentTitle: string | null;
  completedCount: number;
  totalCount: number;
  level: number;
}> {
  const db = getDb();
  const totalCount = getCurriculumCount();

  // Get all users
  const usersResult = db.exec(
    `SELECT id, slack_user_id, display_name, level FROM users WHERE onboarded = 1`,
  );
  if (!usersResult.length) return [];

  return usersResult[0].values.map((row) => {
    const userId = row[0] as number;
    const slackUserId = row[1] as string;
    const displayName = row[2] as string | null;
    const level = row[3] as number;

    const completedResult = db.exec(
      `SELECT COUNT(*) FROM user_curriculum_progress WHERE user_id = ${userId} AND status = 'passed'`,
    );
    const completedCount = completedResult.length ? (completedResult[0].values[0][0] as number) : 0;

    const current = getCurrentUnit(userId);

    return {
      userId,
      displayName,
      slackUserId,
      currentUnit: current?.unit.unitOrder ?? null,
      currentTitle: current?.unit.title ?? null,
      completedCount,
      totalCount,
      level,
    };
  });
}

// ── Progress management ─────────────────────────────────────

/**
 * Initialize progress for a user at a specific starting unit.
 * Marks all units before the start as 'skipped', the start unit as 'active'.
 */
export function initializeUserProgress(userId: number, startUnitOrder: number): void {
  const db = getDb();
  const curriculum = getCurriculum();

  for (const unit of curriculum) {
    const status = unit.unitOrder < startUnitOrder
      ? 'skipped'
      : unit.unitOrder === startUnitOrder
        ? 'active'
        : 'locked';

    const startedAt = status === 'active' ? `datetime('now')` : 'NULL';

    db.run(
      `INSERT INTO user_curriculum_progress (user_id, unit_id, status, started_at)
       VALUES (${userId}, ${unit.id}, '${status}', ${startedAt})
       ON CONFLICT(user_id, unit_id) DO UPDATE SET
         status = '${status}',
         started_at = ${startedAt},
         updated_at = datetime('now')`,
    );
  }

  // Update user's level based on the starting unit's level_band
  const startUnit = curriculum.find((u) => u.unitOrder === startUnitOrder);
  if (startUnit) {
    updateLevel(userId, startUnit.levelBand);
  }

  delLog.info(`Initialized curriculum for user ${userId} at unit ${startUnitOrder}`);
}

/**
 * Activate the next available unit for a user.
 * Returns the newly activated unit, or null if they've completed everything.
 */
export function activateNextUnit(userId: number): CurriculumUnit | null {
  const db = getDb();

  // Find the next locked unit
  const result = db.exec(
    `SELECT ucp.unit_id, cu.unit_order
     FROM user_curriculum_progress ucp
     JOIN curriculum_units cu ON ucp.unit_id = cu.id
     WHERE ucp.user_id = ${userId} AND ucp.status = 'locked' AND cu.status = 'active'
     ORDER BY cu.unit_order ASC LIMIT 1`,
  );

  if (!result.length || !result[0].values.length) return null;

  const unitId = result[0].values[0][0] as number;
  db.run(
    `UPDATE user_curriculum_progress
     SET status = 'active', started_at = datetime('now'), updated_at = datetime('now')
     WHERE user_id = ${userId} AND unit_id = ${unitId}`,
  );

  const unit = getUnit(unitId);
  if (unit) {
    // Update level if the new unit is in a different band
    const user = getUserById(userId);
    if (user && user.level !== unit.levelBand) {
      updateLevel(userId, unit.levelBand);
      delLog.info(`User ${userId} level updated to ${unit.levelBand} (unit ${unit.unitOrder})`);
    }
  }

  return unit;
}

/**
 * Mark a unit as practicing (lesson delivered, exercise presented).
 */
export function markUnitPracticing(userId: number, unitId: number): void {
  const db = getDb();
  db.run(
    `UPDATE user_curriculum_progress
     SET status = 'practicing', updated_at = datetime('now')
     WHERE user_id = ${userId} AND unit_id = ${unitId}`,
  );
}

/**
 * Mark a unit as passed and return whether the user leveled up.
 */
export function markUnitPassed(userId: number, unitId: number, score: number): { leveledUp: boolean; newLevel: number } {
  const db = getDb();

  db.run(
    `UPDATE user_curriculum_progress
     SET status = 'passed', best_score = MAX(COALESCE(best_score, 0), ${score}),
         passed_at = datetime('now'), updated_at = datetime('now')
     WHERE user_id = ${userId} AND unit_id = ${unitId}`,
  );

  // Check if next unit is in a new level band
  const unit = getUnit(unitId);
  const user = getUserById(userId);
  if (!unit || !user) return { leveledUp: false, newLevel: user?.level ?? 1 };

  const nextUnit = getUnitByOrder(unit.unitOrder + 1);
  if (nextUnit && nextUnit.levelBand > unit.levelBand) {
    return { leveledUp: true, newLevel: nextUnit.levelBand };
  }

  return { leveledUp: false, newLevel: user.level };
}

/**
 * Record a failed attempt.
 */
export function recordAttempt(userId: number, unitId: number, score: number): number {
  const db = getDb();
  db.run(
    `UPDATE user_curriculum_progress
     SET attempts = attempts + 1, best_score = MAX(COALESCE(best_score, 0), ${score}),
         updated_at = datetime('now')
     WHERE user_id = ${userId} AND unit_id = ${unitId}`,
  );

  const result = db.exec(
    `SELECT attempts FROM user_curriculum_progress WHERE user_id = ${userId} AND unit_id = ${unitId}`,
  );
  return result.length ? (result[0].values[0][0] as number) : 0;
}

/**
 * Place a user at a specific unit (admin override).
 */
export function placeUserAtUnit(userId: number, unitOrder: number): void {
  const db = getDb();
  // Reset all progress
  db.run(`DELETE FROM user_curriculum_progress WHERE user_id = ${userId}`);
  initializeUserProgress(userId, unitOrder);
}

// ── Unit delivery ───────────────────────────────────────────

/**
 * Generate lesson content for a unit, personalized for the user.
 */
export async function generateUnitLesson(unit: CurriculumUnit, userId: number): Promise<string> {
  const user = getUserById(userId);
  const memoryContext = getMemoryForPrompt(userId);

  const prompt = unit.lessonPrompt
    ?? `Teach the following topic: ${unit.title}. ${unit.description ?? ''}`;

  const system = getPromptOrThrow('deliver_curriculum_unit');
  const systemPrompt = interpolate(system, {
    level: String(unit.levelBand),
    unit_number: String(unit.unitOrder),
    unit_title: unit.title,
    unit_topic: unit.topic,
    lesson_instructions: prompt,
  });

  let fullSystem = systemPrompt;
  if (user?.displayName) {
    fullSystem += `\n\nThe student's name is ${user.displayName}.`;
  }
  if (memoryContext) {
    fullSystem += `\n\n--- Learner Profile ---\n${memoryContext}`;
  }

  const response = await callLlm({
    system: fullSystem,
    messages: [{ role: 'user', content: 'Deliver this lesson to me.' }],
    temperature: 0.7,
    maxTokens: 1024,
  });

  return response.text;
}

/**
 * Generate the exercise prompt for a unit.
 */
export async function generateUnitExercise(unit: CurriculumUnit, userId: number): Promise<string> {
  const user = getUserById(userId);
  const memoryContext = getMemoryForPrompt(userId);

  const prompt = unit.exercisePrompt
    ?? `Create an exercise for: ${unit.title}. ${unit.description ?? ''}`;

  let systemPrompt = `You are a Spanish teacher giving an exercise for Unit ${unit.unitOrder}: ${unit.title} (Level ${unit.levelBand}).

${prompt}

Present the exercise clearly. The student will respond and their answer will be graded.
Keep the exercise focused and achievable. For Level 1-2, keep it simple (1 exercise). For Level 3+, you can include 2-3 parts.`;

  if (user?.displayName) {
    systemPrompt += `\n\nThe student's name is ${user.displayName}.`;
  }
  if (memoryContext) {
    systemPrompt += `\n\n--- Learner Profile ---\n${memoryContext}`;
  }

  const response = await callLlm({
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Give me the exercise.' }],
    temperature: 0.7,
    maxTokens: 512,
  });

  return response.text;
}

// ── Exercise grading ────────────────────────────────────────

/**
 * Grade a student's exercise response.
 */
export async function gradeExerciseResponse(
  unit: CurriculumUnit,
  exerciseText: string,
  studentResponse: string,
  userId: number,
): Promise<GradeResult> {
  const user = getUserById(userId);

  const system = getPromptOrThrow('grade_curriculum_exercise');
  const systemPrompt = interpolate(system, {
    level: String(unit.levelBand),
    unit_title: unit.title,
    unit_topic: unit.topic,
    pass_threshold: String(unit.passThreshold),
  });

  const response = await callLlm({
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Exercise given:\n${exerciseText}\n\nStudent's response:\n${studentResponse}\n\nGrade this response. Return JSON: {"score": 0-5, "passed": boolean, "feedback": "string", "errors": ["string"]}`,
    }],
    temperature: 0.3,
    maxTokens: 512,
  });

  try {
    let cleaned = response.text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    const parsed = JSON.parse(cleaned);

    return {
      score: Math.max(0, Math.min(5, parsed.score ?? 0)),
      passed: parsed.passed ?? (parsed.score >= unit.passThreshold),
      feedback: parsed.feedback ?? 'No feedback provided.',
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      correction: typeof parsed.correction === 'string' ? parsed.correction : '',
    };
  } catch {
    delLog.warn('Failed to parse grading response, defaulting to score 3');
    return {
      score: 3,
      passed: 3 >= unit.passThreshold,
      feedback: response.text.slice(0, 500),
      errors: [],
      correction: '',
    };
  }
}

// ── Format helpers ──────────────────────────────────────────

export function formatLessonBlocks(
  unit: CurriculumUnit,
  lessonText: string,
  totalUnits: number,
): any[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Unit ${unit.unitOrder}/${totalUnits}: ${unit.title}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Level ${unit.levelBand} | ${unit.topic}_` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lessonText },
    },
  ];
}

export function formatExerciseBlocks(exerciseText: string): any[] {
  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Exercise*' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: exerciseText },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Reply with your answer. I\'ll grade it and let you know if you pass!_' }],
    },
  ];
}

export function formatGradeBlocks(result: GradeResult, unit: CurriculumUnit, passed: boolean): any[] {
  const emoji = passed ? ':white_check_mark:' : ':x:';
  const status = passed ? 'Passed!' : 'Not quite — try again!';

  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${status}* (Score: ${result.score}/${unit.passThreshold} needed)` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: result.feedback },
    },
  ];

  if (result.errors.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Errors to work on:*\n${result.errors.map((e) => `• ${e}`).join('\n')}` },
    });
  }

  if (!passed && result.correction) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Correct answer:* _${result.correction}_` },
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':speaker: _Listen to the audio below for an explanation and the correct pronunciation._' }],
    });
  }

  if (passed) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Use `/gringo next` to continue to the next unit!_' }],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Send your answer again to retry, or `/gringo next` to see the lesson again._' }],
    });
  }

  return blocks;
}
