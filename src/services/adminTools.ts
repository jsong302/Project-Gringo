/**
 * Admin Tools — Functions the admin LLM agent can call.
 *
 * Each tool is a pure function that reads/writes the DB and returns
 * a JSON-serializable result. The charla engine's tool loop
 * dispatches tool calls to these functions.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import {
  getSetting,
  setSetting,
  listSettings,
  getAdminUserIds,
} from './settings';
import { getAllUsers, getUserById, updateLevel } from './userService';
import { getUserCardStats } from './srsRepository';
import { getErrorSummary, getRecentErrors, getTotalErrorCount, logLearningError, type ErrorCategory } from './errorTracker';
import { getMemory, getMemoryForPrompt } from './userMemory';
import { listPrompts, upsertPrompt, getPrompt } from './prompts';
import { updateStreak } from './userService';
import type { ToolDefinition } from './llm';
import { getCurriculum, getUnit, updateUnit, reorderUnit, addUnit, archiveUnit, removeUnit } from './curriculum';
import { getAllUsersProgress, placeUserAtUnit } from './curriculumDelivery';
import { logAuditEntry, getAuditLog } from './auditLog';

const toolLog = log.withScope('admin-tools');

// Current admin context for audit logging (set during executeTool)
let _currentAdminSlackId: string | null = null;
function auditAdmin(): string { return _currentAdminSlackId ?? 'unknown'; }

// ── Tool registry ───────────────────────────────────────────

export type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>;

const handlers = new Map<string, ToolHandler>();

function register(name: string, handler: ToolHandler): void {
  handlers.set(name, handler);
}

export async function executeTool(name: string, input: Record<string, unknown>, adminSlackId?: string): Promise<string> {
  const handler = handlers.get(name);
  if (!handler) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  try {
    toolLog.info(`Executing tool: ${name}`, { input });
    _currentAdminSlackId = adminSlackId ?? null;
    const result = await handler(input);
    _currentAdminSlackId = null;
    toolLog.debug(`Tool result: ${name}`, { result: result.slice(0, 200) });
    return result;
  } catch (err) {
    _currentAdminSlackId = null;
    const msg = err instanceof Error ? err.message : String(err);
    toolLog.error(`Tool error: ${name} — ${msg}`);
    return JSON.stringify({ error: msg });
  }
}

// ── Tool definitions (for LLM) ──────────────────────────────

export const ADMIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  // Settings
  {
    name: 'list_settings',
    description: 'List all system settings with their current values, descriptions, and who last updated them.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_setting',
    description: 'Get the current value of a specific setting by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The setting key (e.g. "srs.max_cards_per_session")' },
      },
      required: ['key'],
    },
  },
  {
    name: 'update_setting',
    description: 'Update a system setting. Use this to change XP values, SRS parameters, LLM temperatures, cron schedules, channel IDs, etc.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The setting key' },
        value: { description: 'The new value (number, string, boolean, array, or object)' },
        reason: { type: 'string', description: 'Why this change is being made (logged for audit)' },
      },
      required: ['key', 'value'],
    },
  },

  // Users
  {
    name: 'list_users',
    description: 'List all users with their level, streak, and SRS card stats. Gives an overview of the whole group.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_user_detail',
    description: 'Get detailed info for a specific user: stats, SRS health, error patterns, and learner memory profile.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'Internal user ID' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'update_user_level',
    description: 'Change a user\'s proficiency level (1-5). This affects which content they see.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'Internal user ID' },
        level: { type: 'number', description: 'New level (1-5)' },
      },
      required: ['user_id', 'level'],
    },
  },

  // Errors
  {
    name: 'get_error_trends',
    description: 'Get error trends across all users. Shows which error categories are most common and recent patterns.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_user_errors',
    description: 'Get learning errors for a specific user — categories, counts, and recent examples.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'Internal user ID' },
        limit: { type: 'number', description: 'Max recent errors to return (default 10)' },
      },
      required: ['user_id'],
    },
  },

  // SRS Health
  {
    name: 'get_srs_health',
    description: 'Get SRS health metrics across all users: total cards, due cards, average ease factors, cards per user.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // Prompts
  {
    name: 'list_prompts',
    description: 'List all system prompts (used for lessons, grading, charla, etc.) with their names and descriptions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_prompt',
    description: 'Get the full text of a system prompt by name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Prompt name (e.g. "daily_lesson", "charla_system")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_prompt',
    description: 'Update the text of a system prompt. This affects how lessons are generated, how grading works, etc.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Prompt name' },
        prompt_text: { type: 'string', description: 'New prompt text (supports {{variable}} placeholders)' },
        description: { type: 'string', description: 'Optional description of what the prompt does' },
      },
      required: ['name', 'prompt_text'],
    },
  },

  // Admin management
  {
    name: 'manage_admins',
    description: 'Add or remove admin users. Admins can access the admin agent to manage the bot.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'Action to perform' },
        slack_user_id: { type: 'string', description: 'Slack user ID to add/remove (not needed for list)' },
      },
      required: ['action'],
    },
  },

  // Error pattern analysis
  {
    name: 'analyze_error_patterns',
    description: 'Analyze error patterns across all users over the last 7 days. Shows learning error trends, common mistakes, and system error frequency.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // Charla / Learning tools
  {
    name: 'log_learning_error',
    description: 'Log a language error you noticed during conversation with the admin. Use this when correcting their Spanish so the error is tracked for their learner profile.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'Internal user ID of the admin' },
        category: { type: 'string', enum: ['grammar', 'vocab', 'conjugation', 'pronunciation'], description: 'Error category' },
        description: { type: 'string', description: 'What the error was' },
        user_said: { type: 'string', description: 'What the user actually said' },
        correction: { type: 'string', description: 'The correct form' },
      },
      required: ['user_id', 'category', 'description'],
    },
  },
  {
    name: 'get_learner_context',
    description: 'Get the learner memory profile for the current admin user, so you can personalize the conversation to their level and interests.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'Internal user ID' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'pronounce',
    description: 'Generate an audio pronunciation clip for a Spanish word or phrase. Use this when chatting in Spanish to demonstrate pronunciation of words.',
    input_schema: {
      type: 'object',
      properties: {
        phrase: {
          type: 'string',
          description: 'The Spanish word or phrase to pronounce (e.g. "laburo", "¿Cómo andás?")',
        },
      },
      required: ['phrase'],
    },
  },

  // Curriculum
  {
    name: 'view_curriculum',
    description: 'View the full shared curriculum — all units with their level bands, topics, and status.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'view_curriculum_progress',
    description: "View all users' curriculum progress — current unit, completed count, and level for each user.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'edit_curriculum_unit',
    description: 'Edit a curriculum unit — change title, description, lesson/exercise prompts, pass threshold, or level band.',
    input_schema: {
      type: 'object',
      properties: {
        unit_id: { type: 'number', description: 'The unit ID to edit' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        lesson_prompt: { type: 'string', description: 'New lesson prompt template' },
        exercise_prompt: { type: 'string', description: 'New exercise prompt template' },
        pass_threshold: { type: 'number', description: 'New pass threshold (0-5)' },
        level_band: { type: 'number', description: 'New level band (1-5)' },
      },
      required: ['unit_id'],
    },
  },
  {
    name: 'reorder_curriculum_unit',
    description: 'Move a curriculum unit to a new position in the sequence.',
    input_schema: {
      type: 'object',
      properties: {
        unit_id: { type: 'number', description: 'The unit ID to move' },
        new_order: { type: 'number', description: 'The new position (unit_order)' },
      },
      required: ['unit_id', 'new_order'],
    },
  },
  {
    name: 'add_curriculum_unit',
    description: 'Add a new curriculum unit after a specified position.',
    input_schema: {
      type: 'object',
      properties: {
        after_order: { type: 'number', description: 'Insert after this unit_order (0 = insert at beginning)' },
        topic: { type: 'string', description: 'Unit topic' },
        title: { type: 'string', description: 'Unit title' },
        description: { type: 'string', description: 'Unit description' },
        level_band: { type: 'number', description: 'Level band (1-5)' },
        lesson_prompt: { type: 'string', description: 'Lesson prompt template' },
        exercise_prompt: { type: 'string', description: 'Exercise prompt template' },
        pass_threshold: { type: 'number', description: 'Pass threshold (0-5, default 3)' },
      },
      required: ['after_order', 'topic', 'title', 'level_band'],
    },
  },
  {
    name: 'archive_curriculum_unit',
    description: 'Archive (soft-delete) a curriculum unit. It will no longer appear in the active curriculum.',
    input_schema: {
      type: 'object',
      properties: {
        unit_id: { type: 'number', description: 'The unit ID to archive' },
      },
      required: ['unit_id'],
    },
  },
  {
    name: 'remove_curriculum_unit',
    description: 'Permanently delete a curriculum unit and re-compact the ordering. Also removes its lesson bank entry and user progress. Use archive_curriculum_unit for soft-delete instead.',
    input_schema: {
      type: 'object',
      properties: {
        unit_id: { type: 'number', description: 'The unit ID to permanently delete' },
      },
      required: ['unit_id'],
    },
  },
  {
    name: 'place_user_at_unit',
    description: "Manually place a user at a specific curriculum unit. Resets their progress — units before the target are marked 'skipped'.",
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'Internal user ID' },
        unit_order: { type: 'number', description: 'Unit order number to place them at' },
      },
      required: ['user_id', 'unit_order'],
    },
  },
  // Lesson bank
  {
    name: 'generate_lesson_bank',
    description: 'Generate shared lessons for all units that don\'t have one yet. Lessons are shared across all users. Returns count of generated/skipped/errored.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'regenerate_lesson',
    description: 'Regenerate the shared lesson for a specific unit. Overwrites the existing lesson in the bank. Use this to refresh or fix a lesson.',
    input_schema: {
      type: 'object',
      properties: {
        unit_id: { type: 'number', description: 'The unit ID to regenerate the lesson for' },
      },
      required: ['unit_id'],
    },
  },
  {
    name: 'regenerate_all_lessons',
    description: 'Regenerate ALL lessons in the bank from scratch. Use this after updating prompts or curriculum changes. Runs in background.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'view_lesson_bank',
    description: 'View which units have generated lessons in the bank and which are missing.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  // Exit exam bank
  {
    name: 'generate_exit_exam_bank',
    description: 'Generate exit exam question bank for a level (or all levels 1-4). Generates ~10 questions per unit via LLM. Use force=true to regenerate existing questions.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Level band (1-4). Omit to generate for all levels.' },
        force: { type: 'boolean', description: 'If true, clear and regenerate existing questions.' },
      },
      required: [],
    },
  },
  {
    name: 'view_exit_exam_bank',
    description: 'View how many exit exam questions exist per level.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'bypass_exit_exam',
    description: 'Skip the exit exam and advance a user to the next level. Use for testing or special cases.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: 'User ID to advance' },
        level: { type: 'number', description: 'Current level to bypass (the exam they would take)' },
      },
      required: ['user_id', 'level'],
    },
  },
  // Audit log
  {
    name: 'view_audit_log',
    description: 'View the admin audit log — shows recent admin actions with before/after snapshots. Filter by tool name, target type, or admin.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 20)' },
        tool_name: { type: 'string', description: 'Filter by tool name (e.g. "edit_curriculum_unit")' },
        target_type: { type: 'string', description: 'Filter by target type (e.g. "unit", "setting", "prompt", "user", "admin")' },
      },
      required: [],
    },
  },
  // Content Queue
  {
    name: 'view_content_queue',
    description: 'View upcoming queued content (daily lessons or lunfardo posts). Shows items in scheduled order with title, date, and status.',
    input_schema: {
      type: 'object',
      properties: {
        content_type: { type: 'string', enum: ['daily_lesson', 'lunfardo'], description: 'Filter by content type. Omit for both.' },
        status: { type: 'string', enum: ['ready', 'sent', 'archived'], description: 'Filter by status. Default: ready.' },
        limit: { type: 'number', description: 'Max items to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'view_queue_item',
    description: 'View full details of a single content queue item including its complete content.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Queue item ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'edit_queue_item',
    description: 'Edit a queued content item. You can modify the content JSON, title, scheduled date, or sort order. Blocks are automatically re-rendered from content.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Queue item ID' },
        title: { type: 'string', description: 'New title' },
        content_json: { type: 'string', description: 'New content JSON (full DailyLesson or LunfardoPost object as JSON string)' },
        scheduled_date: { type: 'string', description: 'New scheduled date (YYYY-MM-DD)' },
        sort_order: { type: 'number', description: 'New sort order (lower = earlier)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reorder_queue_item',
    description: 'Move a queued item to a different date and/or position.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Queue item ID' },
        new_date: { type: 'string', description: 'New scheduled date (YYYY-MM-DD)' },
        new_sort_order: { type: 'number', description: 'New sort order (default 0)' },
      },
      required: ['id', 'new_date'],
    },
  },
  {
    name: 'remove_queue_item',
    description: 'Remove a queued content item. Archives by default; use permanent=true to delete entirely.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Queue item ID' },
        permanent: { type: 'boolean', description: 'If true, permanently delete instead of archiving' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_queue_item',
    description: 'Manually add a content item to the queue.',
    input_schema: {
      type: 'object',
      properties: {
        content_type: { type: 'string', enum: ['daily_lesson', 'lunfardo'], description: 'Content type' },
        scheduled_date: { type: 'string', description: 'Scheduled date (YYYY-MM-DD)' },
        content_json: { type: 'string', description: 'Full content JSON (DailyLesson or LunfardoPost object)' },
      },
      required: ['content_type', 'scheduled_date', 'content_json'],
    },
  },
  {
    name: 'regenerate_queue_item',
    description: 'Re-generate a single queue item via LLM. Replaces content with freshly generated content.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Queue item ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'fill_content_queue',
    description: 'Batch generate content to fill the queue for upcoming days. Runs in the background. Skips dates that already have queued items.',
    input_schema: {
      type: 'object',
      properties: {
        content_type: { type: 'string', enum: ['daily_lesson', 'lunfardo'], description: 'Content type to generate. Omit for both.' },
        days: { type: 'number', description: 'Number of days to fill (default 10 for lessons, 14 for lunfardo)' },
      },
      required: [],
    },
  },
  // Exit Exam Question CRUD
  {
    name: 'view_exit_exam_questions',
    description: 'List individual exit exam questions. Filter by level, question type, or source unit.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Filter by level band (1-4)' },
        question_type: { type: 'string', enum: ['mc', 'fill_blank', 'translation'], description: 'Filter by question type' },
        unit_id: { type: 'number', description: 'Filter by source unit ID' },
        limit: { type: 'number', description: 'Max questions to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'edit_exit_exam_question',
    description: 'Edit an individual exit exam question. You can modify the question text, options, correct answer, accepted answers, or reference answer.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Question ID' },
        question_text: { type: 'string', description: 'New question text' },
        options: { type: 'array', items: { type: 'string' }, description: 'New MC options (array of strings)' },
        correct_index: { type: 'number', description: 'New correct option index (0-based)' },
        answers: { type: 'array', items: { type: 'string' }, description: 'New accepted answers for fill_blank' },
        reference_answer: { type: 'string', description: 'New reference answer for translation' },
      },
      required: ['id'],
    },
  },
  {
    name: 'remove_exit_exam_question',
    description: 'Archive an exit exam question (removes it from active question pool).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Question ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_exit_exam_question',
    description: 'Manually add an exit exam question to the question bank.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Level band (1-4)' },
        question_type: { type: 'string', enum: ['mc', 'fill_blank', 'translation'], description: 'Question type' },
        question_text: { type: 'string', description: 'The question text' },
        options: { type: 'array', items: { type: 'string' }, description: 'MC options (required for mc type)' },
        correct_index: { type: 'number', description: 'Correct option index (required for mc type)' },
        answers: { type: 'array', items: { type: 'string' }, description: 'Accepted answers (required for fill_blank type)' },
        translation_direction: { type: 'string', enum: ['en_to_es', 'es_to_en'], description: 'Translation direction (for translation type)' },
        reference_answer: { type: 'string', description: 'Reference answer (required for translation type)' },
        source_unit_id: { type: 'number', description: 'Source curriculum unit ID (optional)' },
      },
      required: ['level', 'question_type', 'question_text'],
    },
  },
];

// ── Tool implementations ────────────────────────────────────

// Settings
register('list_settings', () => {
  const settings = listSettings();
  return JSON.stringify(settings, null, 2);
});

register('get_setting', (input) => {
  const key = input.key as string;
  const settings = listSettings();
  const found = settings.find((s) => s.key === key);
  if (!found) return JSON.stringify({ error: `Setting not found: "${key}"` });
  return JSON.stringify(found, null, 2);
});

register('update_setting', (input) => {
  const key = input.key as string;
  const value = input.value;
  const reason = (input.reason as string) ?? 'Updated by admin agent';
  const before = listSettings().find((s) => s.key === key);
  setSetting(key, value, undefined, `admin-agent: ${reason}`);
  logAuditEntry(auditAdmin(), 'update_setting', 'setting', key, before ?? null, { key, value }, input);
  return JSON.stringify({ success: true, key, value });
});

// Users
register('list_users', () => {
  const users = getAllUsers();
  const result = users.map((u) => {
    const stats = getUserCardStats(u.id);
    return {
      id: u.id,
      slackUserId: u.slackUserId,
      displayName: u.displayName,
      level: u.level,
      streakDays: u.streakDays,
      cards: { total: stats.total, due: stats.due, learning: stats.learning, reviewing: stats.reviewing },
    };
  });
  return JSON.stringify(result, null, 2);
});

register('get_user_detail', (input) => {
  const userId = input.user_id as number;
  const user = getUserById(userId);
  if (!user) return JSON.stringify({ error: `User not found: ${userId}` });

  const stats = getUserCardStats(userId);
  const errors = getErrorSummary(userId);
  const recentErrors = getRecentErrors(userId, 10);
  const totalErrors = getTotalErrorCount(userId);
  const memory = getMemory(userId);

  return JSON.stringify({
    user: {
      id: user.id,
      slackUserId: user.slackUserId,
      displayName: user.displayName,
      level: user.level,
      streakDays: user.streakDays,
      timezone: user.timezone,
      lastPracticeAt: user.lastPracticeAt,
    },
    srs: stats,
    errorSummary: errors,
    totalErrors,
    recentErrors: recentErrors.map((e) => ({
      category: e.errorCategory,
      description: e.description,
      userSaid: e.userSaid,
      correction: e.correction,
      source: e.source,
      createdAt: e.createdAt,
    })),
    memory: memory ? {
      profileSummary: memory.profileSummary,
      strengths: memory.strengths,
      weaknesses: memory.weaknesses,
      interests: memory.interests,
      pronunciationNotes: memory.pronunciationNotes,
      generatedAt: memory.generatedAt,
    } : null,
  }, null, 2);
});

register('update_user_level', (input) => {
  const userId = input.user_id as number;
  const level = input.level as number;
  if (level < 1 || level > 5) return JSON.stringify({ error: 'Level must be 1-5' });

  const user = getUserById(userId);
  if (!user) return JSON.stringify({ error: `User not found: ${userId}` });

  const before = { userId, level: user.level };
  updateLevel(userId, level);
  logAuditEntry(auditAdmin(), 'update_user_level', 'user', userId, before, { userId, level }, input);
  return JSON.stringify({ success: true, userId, previousLevel: user.level, newLevel: level });
});

// Errors
register('get_error_trends', () => {
  const db = getDb();
  const users = getAllUsers();

  // Aggregate errors across all users
  const allSummaries: Record<string, number> = {};
  let totalAcrossUsers = 0;
  for (const u of users) {
    const summary = getErrorSummary(u.id);
    for (const s of summary) {
      allSummaries[s.category] = (allSummaries[s.category] ?? 0) + s.count;
      totalAcrossUsers += s.count;
    }
  }

  // Recent errors across all users (last 20)
  const recentResult = db.exec(
    `SELECT le.*, u.slack_user_id, u.display_name
     FROM learning_errors le
     JOIN users u ON le.user_id = u.id
     ORDER BY le.created_at DESC
     LIMIT 20`,
  );

  const recentErrors = recentResult.length ? recentResult[0].values.map((row) => ({
    id: row[0],
    userId: row[1],
    category: row[2],
    description: row[3],
    userSaid: row[4],
    correction: row[5],
    source: row[6],
    createdAt: row[7],
    slackUserId: row[8],
    displayName: row[9],
  })) : [];

  return JSON.stringify({
    totalErrors: totalAcrossUsers,
    byCategory: allSummaries,
    userCount: users.length,
    recentErrors,
  }, null, 2);
});

register('get_user_errors', (input) => {
  const userId = input.user_id as number;
  const limit = (input.limit as number) ?? 10;

  const summary = getErrorSummary(userId);
  const recent = getRecentErrors(userId, limit);
  const total = getTotalErrorCount(userId);

  return JSON.stringify({
    userId,
    totalErrors: total,
    byCategory: summary,
    recentErrors: recent.map((e) => ({
      category: e.errorCategory,
      description: e.description,
      userSaid: e.userSaid,
      correction: e.correction,
      source: e.source,
      createdAt: e.createdAt,
    })),
  }, null, 2);
});

// SRS Health
register('get_srs_health', () => {
  const db = getDb();
  const users = getAllUsers();

  const perUser = users.map((u) => {
    const stats = getUserCardStats(u.id);
    return { userId: u.id, displayName: u.displayName, level: u.level, ...stats };
  });

  // Aggregate
  const totals = perUser.reduce(
    (acc, u) => ({
      totalCards: acc.totalCards + u.total,
      totalDue: acc.totalDue + u.due,
      totalLearning: acc.totalLearning + u.learning,
      totalReviewing: acc.totalReviewing + u.reviewing,
    }),
    { totalCards: 0, totalDue: 0, totalLearning: 0, totalReviewing: 0 },
  );

  // Average ease factor
  const efResult = db.exec('SELECT AVG(ease_factor) FROM srs_cards');
  const avgEaseFactor = efResult.length ? (efResult[0].values[0][0] as number)?.toFixed(2) : 'N/A';

  return JSON.stringify({
    ...totals,
    averageEaseFactor: avgEaseFactor,
    userCount: users.length,
    perUser,
  }, null, 2);
});

// Prompts
register('list_prompts', () => {
  const prompts = listPrompts();
  return JSON.stringify(prompts.map((p) => ({
    name: p.name,
    description: p.description,
    textPreview: p.promptText.slice(0, 150) + (p.promptText.length > 150 ? '...' : ''),
  })), null, 2);
});

register('get_prompt', (input) => {
  const name = input.name as string;
  const text = getPrompt(name);
  if (!text) return JSON.stringify({ error: `Prompt not found: "${name}"` });
  return JSON.stringify({ name, promptText: text }, null, 2);
});

register('update_prompt', (input) => {
  const name = input.name as string;
  const promptText = input.prompt_text as string;
  const description = input.description as string | undefined;
  const beforeText = getPrompt(name);
  upsertPrompt(name, promptText, description, 'admin-agent');
  logAuditEntry(auditAdmin(), 'update_prompt', 'prompt', name, { name, promptText: beforeText }, { name, promptText }, input);
  return JSON.stringify({ success: true, name, textLength: promptText.length });
});

// Admin management
register('manage_admins', (input) => {
  const action = input.action as string;
  const slackUserId = input.slack_user_id as string | undefined;

  const current = getAdminUserIds();

  switch (action) {
    case 'list':
      return JSON.stringify({ admins: current });

    case 'add': {
      if (!slackUserId) return JSON.stringify({ error: 'slack_user_id is required for add' });
      if (current.includes(slackUserId)) return JSON.stringify({ error: `${slackUserId} is already an admin` });
      const updated = [...current, slackUserId];
      setSetting('admin.user_ids', updated, undefined, 'admin-agent');
      logAuditEntry(auditAdmin(), 'manage_admins', 'admin', slackUserId, { admins: current }, { admins: updated }, input);
      return JSON.stringify({ success: true, action: 'added', slackUserId, admins: updated });
    }

    case 'remove': {
      if (!slackUserId) return JSON.stringify({ error: 'slack_user_id is required for remove' });
      if (!current.includes(slackUserId)) return JSON.stringify({ error: `${slackUserId} is not an admin` });
      if (current.length <= 1) return JSON.stringify({ error: 'Cannot remove the last admin' });
      const updated = current.filter((id) => id !== slackUserId);
      setSetting('admin.user_ids', updated, undefined, 'admin-agent');
      logAuditEntry(auditAdmin(), 'manage_admins', 'admin', slackUserId, { admins: current }, { admins: updated }, input);
      return JSON.stringify({ success: true, action: 'removed', slackUserId, admins: updated });
    }

    default:
      return JSON.stringify({ error: `Unknown action: ${action}. Use add, remove, or list.` });
  }
});

// Charla / Learning
register('log_learning_error', (input) => {
  const userId = input.user_id as number;
  const category = input.category as string;
  const description = input.description as string;
  const userSaid = input.user_said as string | undefined;
  const correction = input.correction as string | undefined;

  const id = logLearningError(userId, category as ErrorCategory, description, userSaid, correction, 'text');
  return JSON.stringify({ success: true, errorId: id });
});

register('get_learner_context', (input) => {
  const userId = input.user_id as number;
  const user = getUserById(userId);
  if (!user) return JSON.stringify({ error: `User not found: ${userId}` });

  const memoryPrompt = getMemoryForPrompt(userId);
  const stats = getUserCardStats(userId);
  const errors = getErrorSummary(userId);

  return JSON.stringify({
    level: user.level,
    streakDays: user.streakDays,
    memoryProfile: memoryPrompt || 'No learner profile generated yet',
    srs: stats,
    topErrors: errors.slice(0, 5),
  }, null, 2);
});

// Pronunciation (async — actual audio generation happens in the handler)
register('pronounce', (input) => {
  const phrase = input.phrase as string;
  toolLog.info(`Pronounce requested: "${phrase}"`);
  return JSON.stringify({ status: 'pending', phrase, message: 'Audio pronunciation will be sent as a voice clip.' });
});

// Curriculum
register('view_curriculum', () => {
  const curriculum = getCurriculum();
  const result = curriculum.map((u) => ({
    id: u.id,
    unitOrder: u.unitOrder,
    topic: u.topic,
    title: u.title,
    levelBand: u.levelBand,
    passThreshold: u.passThreshold,
    status: u.status,
    description: u.description?.slice(0, 100),
  }));
  return JSON.stringify(result, null, 2);
});

register('view_curriculum_progress', () => {
  const progress = getAllUsersProgress();
  return JSON.stringify(progress, null, 2);
});

register('edit_curriculum_unit', (input) => {
  const unitId = input.unit_id as number;
  const unit = getUnit(unitId);
  if (!unit) return JSON.stringify({ error: `Unit not found: ${unitId}` });

  const before = { ...unit };
  const fields: Record<string, unknown> = {};
  if (input.title) fields.title = input.title;
  if (input.description) fields.description = input.description;
  if (input.lesson_prompt) fields.lessonPrompt = input.lesson_prompt;
  if (input.exercise_prompt) fields.exercisePrompt = input.exercise_prompt;
  if (input.pass_threshold != null) fields.passThreshold = input.pass_threshold;
  if (input.level_band != null) fields.levelBand = input.level_band;

  updateUnit(unitId, fields);
  const after = getUnit(unitId);
  logAuditEntry(auditAdmin(), 'edit_curriculum_unit', 'unit', unitId, before, after, input);
  return JSON.stringify({ success: true, unitId, updated: Object.keys(fields) });
});

register('reorder_curriculum_unit', (input) => {
  const unitId = input.unit_id as number;
  const newOrder = input.new_order as number;
  const before = getUnit(unitId);
  reorderUnit(unitId, newOrder);
  logAuditEntry(auditAdmin(), 'reorder_curriculum_unit', 'unit', unitId, { unitOrder: before?.unitOrder }, { unitOrder: newOrder }, input);
  return JSON.stringify({ success: true, unitId, newOrder });
});

register('add_curriculum_unit', (input) => {
  const afterOrder = input.after_order as number;
  const data = {
    topic: input.topic as string,
    title: input.title as string,
    description: (input.description as string) ?? undefined,
    levelBand: input.level_band as number,
    lessonPrompt: (input.lesson_prompt as string) ?? undefined,
    exercisePrompt: (input.exercise_prompt as string) ?? undefined,
  };
  const newId = addUnit(afterOrder, data);
  const after = getUnit(newId);
  logAuditEntry(auditAdmin(), 'add_curriculum_unit', 'unit', newId, null, after, input);
  return JSON.stringify({ success: true, newUnitId: newId, insertedAfterOrder: afterOrder });
});

register('archive_curriculum_unit', (input) => {
  const unitId = input.unit_id as number;
  const before = getUnit(unitId);
  archiveUnit(unitId);
  logAuditEntry(auditAdmin(), 'archive_curriculum_unit', 'unit', unitId, before, { ...before, status: 'archived' }, input);
  return JSON.stringify({ success: true, unitId, status: 'archived' });
});

register('remove_curriculum_unit', (input) => {
  const unitId = input.unit_id as number;
  const unit = getUnit(unitId);
  if (!unit) return JSON.stringify({ error: `Unit ${unitId} not found` });
  const before = { ...unit };
  removeUnit(unitId);
  logAuditEntry(auditAdmin(), 'remove_curriculum_unit', 'unit', unitId, before, null, input);
  return JSON.stringify({ success: true, unitId, title: before.title, status: 'permanently_deleted' });
});

register('place_user_at_unit', (input) => {
  const userId = input.user_id as number;
  const unitOrder = input.unit_order as number;
  const user = getUserById(userId);
  if (!user) return JSON.stringify({ error: `User not found: ${userId}` });

  const before = { userId, level: user.level };
  placeUserAtUnit(userId, unitOrder);
  logAuditEntry(auditAdmin(), 'place_user_at_unit', 'user', userId, before, { userId, placedAtUnit: unitOrder }, input);
  return JSON.stringify({ success: true, userId, placedAtUnit: unitOrder });
});

register('analyze_error_patterns', () => {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Learning errors by category (last 7 days)
  const learningByCategory = db.exec(
    `SELECT error_category, COUNT(*) as count
     FROM learning_errors
     WHERE created_at >= '${sevenDaysAgo}'
     GROUP BY error_category
     ORDER BY count DESC`,
  );
  const categoryBreakdown = learningByCategory.length
    ? learningByCategory[0].values.map((row) => ({ category: row[0], count: row[1] }))
    : [];

  // Learning errors by user (last 7 days)
  const learningByUser = db.exec(
    `SELECT u.display_name, u.slack_user_id, COUNT(*) as count
     FROM learning_errors le
     JOIN users u ON le.user_id = u.id
     WHERE le.created_at >= '${sevenDaysAgo}'
     GROUP BY le.user_id
     ORDER BY count DESC`,
  );
  const userBreakdown = learningByUser.length
    ? learningByUser[0].values.map((row) => ({ displayName: row[0], slackUserId: row[1], count: row[2] }))
    : [];

  // Learning errors by day (last 7 days)
  const learningByDay = db.exec(
    `SELECT date(created_at) as day, COUNT(*) as count
     FROM learning_errors
     WHERE created_at >= '${sevenDaysAgo}'
     GROUP BY date(created_at)
     ORDER BY day`,
  );
  const dailyTrend = learningByDay.length
    ? learningByDay[0].values.map((row) => ({ day: row[0], count: row[1] }))
    : [];

  // Sample recent learning error descriptions per category
  const sampleErrors = db.exec(
    `SELECT error_category, description, user_said, correction
     FROM learning_errors
     WHERE created_at >= '${sevenDaysAgo}'
     ORDER BY created_at DESC
     LIMIT 15`,
  );
  const samples = sampleErrors.length
    ? sampleErrors[0].values.map((row) => ({
        category: row[0],
        description: row[1],
        userSaid: row[2],
        correction: row[3],
      }))
    : [];

  // System errors by error_code (last 7 days)
  const systemByCode = db.exec(
    `SELECT error_code, COUNT(*) as count, MAX(message) as sample_message
     FROM system_errors
     WHERE created_at >= '${sevenDaysAgo}'
     GROUP BY error_code
     ORDER BY count DESC`,
  );
  const systemBreakdown = systemByCode.length
    ? systemByCode[0].values.map((row) => ({ errorCode: row[0], count: row[1], sampleMessage: row[2] }))
    : [];

  // Total counts
  const totalLearningResult = db.exec(
    `SELECT COUNT(*) FROM learning_errors WHERE created_at >= '${sevenDaysAgo}'`,
  );
  const totalLearning = totalLearningResult.length ? (totalLearningResult[0].values[0][0] as number) : 0;

  const totalSystemResult = db.exec(
    `SELECT COUNT(*) FROM system_errors WHERE created_at >= '${sevenDaysAgo}'`,
  );
  const totalSystem = totalSystemResult.length ? (totalSystemResult[0].values[0][0] as number) : 0;

  return JSON.stringify({
    period: 'last 7 days',
    learningErrors: {
      total: totalLearning,
      byCategory: categoryBreakdown,
      byUser: userBreakdown,
      dailyTrend,
      recentSamples: samples,
    },
    systemErrors: {
      total: totalSystem,
      byErrorCode: systemBreakdown,
    },
  }, null, 2);
});

// Lesson bank
register('view_lesson_bank', () => {
  const db = getDb();
  const curriculum = getCurriculum();
  const bankResult = db.exec('SELECT unit_id, generated_at FROM lesson_bank');
  const bankMap = new Map<number, string>();
  if (bankResult.length) {
    for (const row of bankResult[0].values) {
      bankMap.set(row[0] as number, row[1] as string);
    }
  }
  const status = curriculum.map(u => ({
    unitOrder: u.unitOrder,
    title: u.title,
    hasLesson: bankMap.has(u.id),
    generatedAt: bankMap.get(u.id) ?? null,
  }));
  const total = curriculum.length;
  const generated = status.filter(s => s.hasLesson).length;
  const { isBankGenerationRunning } = require('./curriculumDelivery');
  return JSON.stringify({ total, generated, missing: total - generated, generating: isBankGenerationRunning(), units: status }, null, 2);
});

register('generate_lesson_bank', () => {
  const { isBankGenerationRunning, generateAllBankLessons } = require('./curriculumDelivery');
  if (isBankGenerationRunning()) {
    return JSON.stringify({
      success: false,
      message: 'Lesson bank generation is already running. Use view_lesson_bank to check progress.',
    });
  }
  // Fire-and-forget — generation runs in the background since it takes minutes
  generateAllBankLessons().then((result: any) => {
    toolLog.info(`Lesson bank generation complete: ${JSON.stringify(result)}`);
  }).catch((err: any) => {
    toolLog.error(`Lesson bank generation failed: ${err}`);
  });
  return JSON.stringify({
    success: true,
    message: 'Lesson bank generation started in the background. Use view_lesson_bank to check status.',
  });
});

register('regenerate_all_lessons', () => {
  const { isBankGenerationRunning, generateAllBankLessons } = require('./curriculumDelivery');
  if (isBankGenerationRunning()) {
    return JSON.stringify({
      success: false,
      message: 'Lesson bank generation is already running. Use view_lesson_bank to check progress.',
    });
  }
  generateAllBankLessons(true).then((result: any) => {
    toolLog.info(`Lesson bank regeneration complete: ${JSON.stringify(result)}`);
  }).catch((err: any) => {
    toolLog.error(`Lesson bank regeneration failed: ${err}`);
  });
  return JSON.stringify({
    success: true,
    message: 'Regenerating ALL lessons in the background. This will take a while. Use view_lesson_bank to check progress.',
  });
});

register('regenerate_lesson', async (input) => {
  const unitId = input.unit_id as number;
  const { generateAndBankLesson, getLessonFromBank } = await import('./curriculumDelivery');
  const beforeText = getLessonFromBank(unitId);
  const lessonText = await generateAndBankLesson(unitId);
  logAuditEntry(auditAdmin(), 'regenerate_lesson', 'lesson', unitId, { unitId, hadLesson: !!beforeText }, { unitId, lessonLength: lessonText.length }, input);
  return JSON.stringify({ success: true, unitId, lessonLength: lessonText.length });
});

// Exit exam bank
register('generate_exit_exam_bank', (input) => {
  const { isExamBankGenerating, generateBankForLevel, generateAllExamBanks } = require('./exitExamBank');
  if (isExamBankGenerating()) {
    return JSON.stringify({
      success: false,
      message: 'Exit exam bank generation is already running.',
    });
  }
  const level = input.level as number | undefined;
  const force = (input.force as boolean) ?? false;

  if (level) {
    generateBankForLevel(level, force).then((result: any) => {
      toolLog.info(`Exit exam bank for level ${level}: ${JSON.stringify(result)}`);
    }).catch((err: any) => {
      toolLog.error(`Exit exam bank generation failed: ${err}`);
    });
    return JSON.stringify({
      success: true,
      message: `Generating exit exam questions for level ${level} in the background.${force ? ' (force mode — replacing existing questions)' : ''}`,
    });
  }

  generateAllExamBanks(force).then((result: any) => {
    toolLog.info(`All exit exam banks: ${JSON.stringify(result)}`);
  }).catch((err: any) => {
    toolLog.error(`Exit exam bank generation failed: ${err}`);
  });
  return JSON.stringify({
    success: true,
    message: `Generating exit exam questions for all levels (1-4) in the background.${force ? ' (force mode — replacing existing questions)' : ''}`,
  });
});

register('view_exit_exam_bank', () => {
  const { getQuestionBankStats } = require('./exitExam');
  const stats = getQuestionBankStats();
  return JSON.stringify({
    levels: stats,
    total: stats.reduce((sum: number, s: any) => sum + s.count, 0),
    message: stats.length === 0
      ? 'No exit exam questions generated yet. Use generate_exit_exam_bank to create them.'
      : `${stats.reduce((sum: number, s: any) => sum + s.count, 0)} total questions across ${stats.length} levels.`,
  }, null, 2);
});

register('bypass_exit_exam', (input) => {
  const userId = input.user_id as number;
  const level = input.level as number;
  const user = getUserById(userId);
  if (!user) return JSON.stringify({ error: `User not found: ${userId}` });

  // Insert a passing exam attempt
  const db = getDb();
  db.run(
    `INSERT INTO exit_exam_attempts (user_id, level_band, questions_json, total_correct, total_questions, passed)
     VALUES (${userId}, ${level}, '[]', 0, 0, 1)`,
  );

  // Advance to next level and unlock all its units
  const newLevel = level + 1;
  updateLevel(userId, newLevel);
  const { unlockLevel } = require('./curriculumDelivery');
  const unlocked = unlockLevel(userId, newLevel);

  logAuditEntry(auditAdmin(), 'bypass_exit_exam', 'user', userId, { level: user.level }, { level: newLevel }, input);
  return JSON.stringify({
    success: true,
    message: `Bypassed level ${level} exit exam for user ${user.displayName ?? userId}. Advanced to level ${newLevel}, ${unlocked} units unlocked.`,
  });
});

// Audit log
register('view_audit_log', (input) => {
  const entries = getAuditLog({
    limit: (input.limit as number) ?? 20,
    toolName: input.tool_name as string | undefined,
    targetType: input.target_type as string | undefined,
  });
  return JSON.stringify({
    count: entries.length,
    entries: entries.map((e) => ({
      id: e.id,
      admin: e.adminSlackId,
      tool: e.toolName,
      targetType: e.targetType,
      targetId: e.targetId,
      before: e.beforeSnapshot,
      after: e.afterSnapshot,
      timestamp: e.timestamp,
    })),
  }, null, 2);
});

// ── Content Queue tools ──────────────────────────────────────

register('view_content_queue', (input) => {
  const { getQueueItems, getQueueStats } = require('./contentQueue');
  const status = (input.status as string) ?? 'ready';
  const items = getQueueItems({
    contentType: input.content_type as any,
    status,
    limit: (input.limit as number) ?? 20,
  });
  const stats = getQueueStats();
  return JSON.stringify({
    stats,
    count: items.length,
    items: items.map((item: any) => ({
      id: item.id,
      type: item.contentType,
      date: item.scheduledDate,
      title: item.title,
      status: item.status,
      difficulty: item.difficulty,
      sortOrder: item.sortOrder,
    })),
  }, null, 2);
});

register('view_queue_item', (input) => {
  const { getQueueItem } = require('./contentQueue');
  const item = getQueueItem(input.id as number);
  if (!item) return JSON.stringify({ error: 'Queue item not found' });
  return JSON.stringify({
    id: item.id,
    type: item.contentType,
    date: item.scheduledDate,
    status: item.status,
    title: item.title,
    difficulty: item.difficulty,
    sortOrder: item.sortOrder,
    content: JSON.parse(item.contentJson),
    postedAt: item.postedAt,
    createdAt: item.createdAt,
  }, null, 2);
});

register('edit_queue_item', (input) => {
  const { getQueueItem, updateQueueItem, rerenderBlocks } = require('./contentQueue');
  const id = input.id as number;
  const before = getQueueItem(id);
  if (!before) return JSON.stringify({ error: 'Queue item not found' });

  const fields: Record<string, unknown> = {};
  if (input.title) fields.title = input.title;
  if (input.scheduled_date) fields.scheduledDate = input.scheduled_date;
  if (input.sort_order !== undefined) fields.sortOrder = input.sort_order;
  if (input.content_json) {
    fields.contentJson = input.content_json as string;
    // Re-render blocks from new content
    const tempItem = { ...before, contentJson: input.content_json as string };
    fields.blocksJson = rerenderBlocks(tempItem);
  }

  updateQueueItem(id, fields);
  const after = getQueueItem(id);
  logAuditEntry(auditAdmin(), 'edit_queue_item', 'queue', id,
    { title: before.title, date: before.scheduledDate },
    { title: after?.title, date: after?.scheduledDate },
    input,
  );
  return JSON.stringify({ success: true, id, updated: Object.keys(fields) });
});

register('reorder_queue_item', (input) => {
  const { getQueueItem, reorderQueueItem } = require('./contentQueue');
  const id = input.id as number;
  const before = getQueueItem(id);
  if (!before) return JSON.stringify({ error: 'Queue item not found' });

  const newDate = input.new_date as string;
  const newSortOrder = (input.new_sort_order as number) ?? 0;
  reorderQueueItem(id, newDate, newSortOrder);

  logAuditEntry(auditAdmin(), 'reorder_queue_item', 'queue', id,
    { date: before.scheduledDate, sortOrder: before.sortOrder },
    { date: newDate, sortOrder: newSortOrder },
    input,
  );
  return JSON.stringify({ success: true, id, newDate, newSortOrder });
});

register('remove_queue_item', (input) => {
  const { getQueueItem, archiveQueueItem, deleteQueueItem } = require('./contentQueue');
  const id = input.id as number;
  const item = getQueueItem(id);
  if (!item) return JSON.stringify({ error: 'Queue item not found' });

  const permanent = (input.permanent as boolean) ?? false;
  if (permanent) {
    deleteQueueItem(id);
  } else {
    archiveQueueItem(id);
  }

  logAuditEntry(auditAdmin(), 'remove_queue_item', 'queue', id,
    { title: item.title, date: item.scheduledDate, status: item.status },
    { status: permanent ? 'deleted' : 'archived' },
    input,
  );
  return JSON.stringify({ success: true, id, action: permanent ? 'deleted' : 'archived' });
});

register('add_queue_item', (input) => {
  const { insertQueueItem, rerenderBlocks } = require('./contentQueue');
  const { formatDailyLessonBlocks, formatLunfardoBlocks } = require('./lessonEngine');
  const contentType = input.content_type as string;
  const scheduledDate = input.scheduled_date as string;
  const contentJson = input.content_json as string;

  // Validate JSON
  let parsed: any;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return JSON.stringify({ error: 'Invalid content_json — must be valid JSON' });
  }

  const title = contentType === 'daily_lesson' ? parsed.title : parsed.word;
  let blocks: any[];
  if (contentType === 'daily_lesson') {
    blocks = formatDailyLessonBlocks(parsed);
  } else {
    blocks = formatLunfardoBlocks(parsed);
  }

  const id = insertQueueItem({
    contentType: contentType as any,
    scheduledDate,
    title: title ?? 'Untitled',
    contentJson,
    blocksJson: JSON.stringify(blocks),
    difficulty: parsed.difficulty,
  });

  logAuditEntry(auditAdmin(), 'add_queue_item', 'queue', id,
    null, { contentType, scheduledDate, title }, input,
  );
  return JSON.stringify({ success: true, id, title, scheduledDate });
});

register('regenerate_queue_item', async (input) => {
  const { regenerateQueueItem } = require('./contentQueue');
  const id = input.id as number;
  const item = await regenerateQueueItem(id);
  if (!item) return JSON.stringify({ error: 'Queue item not found' });
  return JSON.stringify({ success: true, id, title: item.title });
});

register('fill_content_queue', (input) => {
  const { isQueueGenerationRunning, generateLessonQueue, generateLunfardoQueue } = require('./contentQueue');
  if (isQueueGenerationRunning()) {
    return JSON.stringify({ success: false, message: 'Queue generation is already running.' });
  }

  const contentType = input.content_type as string | undefined;
  const days = (input.days as number) ?? undefined;

  if (contentType === 'daily_lesson') {
    generateLessonQueue(days ?? 10).then((r: any) => toolLog.info(`Lesson queue fill: ${JSON.stringify(r)}`)).catch((e: any) => toolLog.error(`Lesson queue fill failed: ${e}`));
    return JSON.stringify({ success: true, message: `Generating daily lessons for the next ${days ?? 10} weekdays in the background.` });
  }
  if (contentType === 'lunfardo') {
    generateLunfardoQueue(days ?? 14).then((r: any) => toolLog.info(`Lunfardo queue fill: ${JSON.stringify(r)}`)).catch((e: any) => toolLog.error(`Lunfardo queue fill failed: ${e}`));
    return JSON.stringify({ success: true, message: `Generating lunfardo posts for the next ${days ?? 14} days in the background.` });
  }

  // Both types
  generateLessonQueue(days ?? 10).then((r: any) => {
    toolLog.info(`Lesson queue fill: ${JSON.stringify(r)}`);
    return generateLunfardoQueue(days ?? 14);
  }).then((r: any) => {
    toolLog.info(`Lunfardo queue fill: ${JSON.stringify(r)}`);
  }).catch((e: any) => toolLog.error(`Queue fill failed: ${e}`));
  return JSON.stringify({ success: true, message: `Generating daily lessons (${days ?? 10} weekdays) and lunfardo posts (${days ?? 14} days) in the background.` });
});

// ── Exit Exam Question CRUD tools ────────────────────────────

register('view_exit_exam_questions', (input) => {
  const db = getDb();
  const conditions: string[] = [`status = 'active'`];
  if (input.level) conditions.push(`level_band = ${input.level}`);
  if (input.question_type) conditions.push(`question_type = '${input.question_type}'`);
  if (input.unit_id) conditions.push(`source_unit_id = ${input.unit_id}`);
  const where = conditions.join(' AND ');
  const limit = (input.limit as number) ?? 20;

  const result = db.exec(
    `SELECT id, level_band, source_unit_id, question_type, question_text, options_json, correct_index, answers_json, translation_direction, reference_answer
     FROM exit_exam_questions WHERE ${where} ORDER BY id ASC LIMIT ${limit}`,
  );
  if (!result.length) return JSON.stringify({ count: 0, questions: [] });

  const questions = result[0].values.map((row: any) => ({
    id: row[0],
    level: row[1],
    unitId: row[2],
    type: row[3],
    text: row[4],
    options: row[5] ? JSON.parse(row[5]) : null,
    correctIndex: row[6],
    answers: row[7] ? JSON.parse(row[7]) : null,
    direction: row[8],
    referenceAnswer: row[9],
  }));
  return JSON.stringify({ count: questions.length, questions }, null, 2);
});

register('edit_exit_exam_question', (input) => {
  const db = getDb();
  const id = input.id as number;
  const esc = (s: string) => s.replace(/'/g, "''");

  // Get before snapshot
  const beforeResult = db.exec(`SELECT question_text, options_json, correct_index, answers_json, reference_answer FROM exit_exam_questions WHERE id = ${id}`);
  if (!beforeResult.length || !beforeResult[0].values.length) return JSON.stringify({ error: 'Question not found' });
  const before = beforeResult[0].values[0];

  const sets: string[] = [];
  if (input.question_text) sets.push(`question_text = '${esc(input.question_text as string)}'`);
  if (input.options) sets.push(`options_json = '${esc(JSON.stringify(input.options))}'`);
  if (input.correct_index !== undefined) sets.push(`correct_index = ${input.correct_index}`);
  if (input.answers) sets.push(`answers_json = '${esc(JSON.stringify(input.answers))}'`);
  if (input.reference_answer) sets.push(`reference_answer = '${esc(input.reference_answer as string)}'`);

  if (sets.length === 0) return JSON.stringify({ error: 'No fields to update' });

  db.run(`UPDATE exit_exam_questions SET ${sets.join(', ')} WHERE id = ${id}`);

  logAuditEntry(auditAdmin(), 'edit_exit_exam_question', 'exam_question', id,
    { text: before[0], options: before[1], correctIndex: before[2], answers: before[3], referenceAnswer: before[4] },
    input,
    input,
  );
  return JSON.stringify({ success: true, id, updated: sets.length });
});

register('remove_exit_exam_question', (input) => {
  const { archiveQuestion } = require('./exitExam');
  const id = input.id as number;
  archiveQuestion(id);
  logAuditEntry(auditAdmin(), 'remove_exit_exam_question', 'exam_question', id, { status: 'active' }, { status: 'archived' }, input);
  return JSON.stringify({ success: true, id, status: 'archived' });
});

register('add_exit_exam_question', (input) => {
  const { insertQuestion } = require('./exitExam');
  const level = input.level as number;
  const questionType = input.question_type as 'mc' | 'fill_blank' | 'translation';
  const questionText = input.question_text as string;
  const options = input.options as string[] | undefined ?? null;
  const correctIndex = input.correct_index as number | undefined ?? null;
  const answers = input.answers as string[] | undefined ?? null;
  const translationDirection = input.translation_direction as string | undefined ?? null;
  const referenceAnswer = input.reference_answer as string | undefined ?? null;
  const sourceUnitId = input.source_unit_id as number | undefined ?? null;

  insertQuestion(level, sourceUnitId, questionType, questionText, options, correctIndex, answers, translationDirection as any, referenceAnswer);

  logAuditEntry(auditAdmin(), 'add_exit_exam_question', 'exam_question', null, null, { level, questionType, questionText }, input);
  return JSON.stringify({ success: true, level, questionType, questionText: questionText.slice(0, 80) });
});

