/**
 * Admin Tools — Functions the admin LLM agent can call.
 *
 * Each tool is a pure function that reads/writes the DB and returns
 * a JSON-serializable result. The agent loop in adminAgent.ts
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

const toolLog = log.withScope('admin-tools');

// ── Tool registry ───────────────────────────────────────────

export type ToolHandler = (input: Record<string, unknown>) => string;

const handlers = new Map<string, ToolHandler>();

function register(name: string, handler: ToolHandler): void {
  handlers.set(name, handler);
}

export function executeTool(name: string, input: Record<string, unknown>): string {
  const handler = handlers.get(name);
  if (!handler) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  try {
    toolLog.info(`Executing tool: ${name}`, { input });
    const result = handler(input);
    toolLog.debug(`Tool result: ${name}`, { result: result.slice(0, 200) });
    return result;
  } catch (err) {
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
    description: 'List all users with their level, XP, streak, and SRS card stats. Gives an overview of the whole group.',
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
  setSetting(key, value, undefined, `admin-agent: ${reason}`);
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

  updateLevel(userId, level);
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
  upsertPrompt(name, promptText, description, 'admin-agent');
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
      return JSON.stringify({ success: true, action: 'added', slackUserId, admins: updated });
    }

    case 'remove': {
      if (!slackUserId) return JSON.stringify({ error: 'slack_user_id is required for remove' });
      if (!current.includes(slackUserId)) return JSON.stringify({ error: `${slackUserId} is not an admin` });
      if (current.length <= 1) return JSON.stringify({ error: 'Cannot remove the last admin' });
      const updated = current.filter((id) => id !== slackUserId);
      setSetting('admin.user_ids', updated, undefined, 'admin-agent');
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

