import { callLlm } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { getDb } from '../db';
import { log } from '../utils/logger';
import { logGradingErrors, type ErrorCategory } from './errorTracker';
import { createCard, type CardType } from './srsRepository';
import { getSetting } from './settings';
import { getPlanContext } from './lessonPlan';
import { getAllUsers } from './userService';

const lessonLog = log.withScope('lesson');

// ── Types ───────────────────────────────────────────────────

export interface DailyLesson {
  title: string;
  grammar_topic: string;
  vocabulary: { word: string; meaning: string; example: string }[];
  exercise: string;
  cultural_note: string;
  difficulty: number;
}

export interface LunfardoPost {
  word: string;
  meaning_es: string;
  meaning_en: string;
  etymology: string;
  examples: string[];
  vesre: string | null;
  category: string;
}

// ── JSON parsing (exported for testing) ─────────────────────

export function parseLlmJson<T>(text: string): T {
  // LLMs sometimes wrap JSON in markdown code fences
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  return JSON.parse(cleaned);
}

// ── Block Kit formatting (exported for testing) ─────────────

export function formatDailyLessonBlocks(lesson: DailyLesson): any[] {
  const vocabLines = lesson.vocabulary
    .map((v) => `• *${v.word}* — ${v.meaning}\n  _"${v.example}"_`)
    .join('\n');

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📚 ${lesson.title}`, emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Topic:*\n${lesson.grammar_topic}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Vocabulary:*\n${vocabLines}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🎙️ Speaking Exercise:*\n${lesson.exercise}\n\n_Reply in the thread with a voice memo!_`,
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🇦🇷 *Cultural Note:* ${lesson.cultural_note}`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Level: ${'⭐'.repeat(lesson.difficulty)}`,
        },
      ],
    },
  ];
}

export function formatLunfardoBlocks(post: LunfardoPost): any[] {
  const exampleLines = post.examples
    .map((ex) => `• _"${ex}"_`)
    .join('\n');

  const vesreLine = post.vesre ? `\n*Vesre:* ${post.vesre}` : '';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🗣️ Slang of the Day: ${post.word}`,
        emoji: true,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*In Spanish:* ${post.meaning_es}\n*In English:* ${post.meaning_en}${vesreLine}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Etymology:* ${post.etymology}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Examples:*\n${exampleLines}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Category: *${post.category}*`,
        },
      ],
    },
  ];
}

// ── Recent lessons (for dedup) ──────────────────────────────

/**
 * Get the titles of recent daily lessons to avoid repeating topics.
 */
export function getRecentLessonTopics(limit = 7): string[] {
  const db = getDb();
  const result = db.exec(
    `SELECT topic FROM lesson_log WHERE lesson_type = 'daily' ORDER BY posted_at DESC LIMIT ${limit}`,
  );
  if (!result.length) return [];
  return result[0].values.map((row) => row[0] as string);
}

// ── Lesson generation ───────────────────────────────────────

export async function generateDailyLesson(level: number, additionalRecentTopics?: string[]): Promise<{
  lesson: DailyLesson;
  blocks: any[];
}> {
  const promptTemplate = getPromptOrThrow('daily_lesson');

  // Build plan context — aggregate from all users (channel-wide lesson)
  const users = getAllUsers().filter((u) => u.onboarded);
  const planContextParts: string[] = [];
  for (const user of users) {
    const ctx = getPlanContext(user.id);
    if (ctx) planContextParts.push(`${user.displayName ?? 'Student'}: ${ctx}`);
  }
  const planContext = planContextParts.length > 0
    ? `Student lesson plans:\n${planContextParts.join('\n\n')}`
    : '';

  // Build previous lessons context (combine posted + queued topics for dedup)
  const recentTopics = getRecentLessonTopics();
  const allTopics = additionalRecentTopics
    ? [...new Set([...recentTopics, ...additionalRecentTopics])]
    : recentTopics;
  const previousLessons = allTopics.length > 0
    ? `Previous lessons (do NOT repeat these topics): ${allTopics.join(', ')}`
    : '';

  const prompt = interpolate(promptTemplate, {
    level: String(level),
    plan_context: planContext,
    previous_lessons: previousLessons,
  });

  const response = await callLlm({
    system: 'Respond only with valid JSON. No additional text.',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
  });

  const lesson = parseLlmJson<DailyLesson>(response.text);
  const blocks = formatDailyLessonBlocks(lesson);

  lessonLog.info(`Generated daily lesson: "${lesson.title}" (level ${level})`);

  return { lesson, blocks };
}

export async function generateLunfardoPost(): Promise<{
  post: LunfardoPost;
  blocks: any[];
}> {
  const promptTemplate = getPromptOrThrow('lunfardo_del_dia');

  const response = await callLlm({
    system: 'Respond only with valid JSON. No additional text.',
    messages: [{ role: 'user', content: promptTemplate }],
    temperature: 0.9,
  });

  const post = parseLlmJson<LunfardoPost>(response.text);
  const blocks = formatLunfardoBlocks(post);

  lessonLog.info(`Generated lunfardo post: "${post.word}"`);

  return { post, blocks };
}

// ── Lesson logging ──────────────────────────────────────────

export function logLesson(opts: {
  lessonType: string;
  topic: string;
  contentJson: string;
  slackChannelId?: string;
  slackMessageTs?: string;
}): number {
  const db = getDb();
  db.run(
    `INSERT INTO lesson_log (lesson_type, topic, content_json, slack_channel_id, slack_message_ts)
     VALUES ('${opts.lessonType}', '${escapeSql(opts.topic)}', '${escapeSql(opts.contentJson)}', ${opts.slackChannelId ? `'${opts.slackChannelId}'` : 'NULL'}, ${opts.slackMessageTs ? `'${opts.slackMessageTs}'` : 'NULL'})`,
  );

  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0] as number;
}

// ── Lesson grading ──────────────────────────────────────────

export interface GradingResult {
  correct: 'yes' | 'partial' | 'no';
  score: number;
  errors: Array<{ type: ErrorCategory; description: string; correction: string }>;
  praise: string;
  suggestion: string;
  responseEs: string;
}

/**
 * Grade a student's text or voice response to a lesson exercise.
 */
export async function gradeLessonResponse(
  exercise: string,
  studentResponse: string,
  userLevel: number,
  userId: number,
): Promise<GradingResult> {
  const template = getPromptOrThrow('grade_voice_response');
  const prompt = interpolate(template, {
    level: String(userLevel),
    exercise,
    transcript: studentResponse,
  });

  const response = await callLlm({
    system: 'Respond only with valid JSON. No additional text.',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    maxTokens: 512,
  });

  const parsed = parseLlmJson<any>(response.text);

  const result: GradingResult = {
    correct: parsed.correct ?? 'no',
    score: parsed.score ?? 0,
    errors: parsed.errors ?? [],
    praise: parsed.praise ?? '',
    suggestion: parsed.suggestion ?? '',
    responseEs: parsed.response_es ?? '',
  };

  // Log errors to errorTracker
  if (result.errors.length > 0) {
    logGradingErrors(userId, result.errors, studentResponse, 'text');
  }

  lessonLog.info(`Graded lesson response: ${result.correct} (score ${result.score}/5)`);
  return result;
}

/**
 * Format grading result as Slack blocks.
 */
export function formatGradingBlocks(result: GradingResult): object[] {
  const scoreEmoji = result.score >= 4 ? '🌟' : result.score >= 3 ? '👍' : '💪';
  const correctLabel = result.correct === 'yes' ? '✅ Correcto' : result.correct === 'partial' ? '🟡 Parcialmente' : '❌ Incorrecto';

  const blocks: object[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${correctLabel} — ${scoreEmoji} ${result.score}/5`,
      },
    },
  ];

  if (result.praise) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Lo bueno:* ${result.praise}` },
    });
  }

  if (result.errors.length > 0) {
    const errorLines = result.errors
      .map((e) => `• _${e.type}:_ ${e.description} → *${e.correction}*`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Errores:*\n${errorLines}` },
    });
  }

  if (result.suggestion) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `💡 ${result.suggestion}` }],
    });
  }

  if (result.responseEs) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: result.responseEs },
    });
  }

  return blocks;
}

// ── Lesson lookup ────────────────────────────────────────────

/**
 * Find a lesson by its Slack message timestamp.
 */
export function getLessonByMessageTs(
  channelId: string,
  messageTs: string,
): { id: number; contentJson: string } | null {
  const db = getDb();
  const result = db.exec(
    `SELECT id, content_json FROM lesson_log
     WHERE slack_channel_id = '${escapeSql(channelId)}'
       AND slack_message_ts = '${escapeSql(messageTs)}'
     LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return {
    id: result[0].values[0][0] as number,
    contentJson: result[0].values[0][1] as string,
  };
}

// ── Lesson engagement ────────────────────────────────────────

export function logLessonEngagement(
  lessonLogId: number,
  userId: number,
  type: 'voice_response' | 'text_response' | 'reaction',
  reactionEmoji?: string,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO lesson_engagement (lesson_log_id, user_id, engagement_type, reaction_emoji)
     VALUES (${lessonLogId}, ${userId}, '${type}', ${reactionEmoji ? `'${escapeSql(reactionEmoji)}'` : 'NULL'})`,
  );
  lessonLog.debug(`Logged engagement: user ${userId} ${type} on lesson ${lessonLogId}`);
}

// ── Auto-create SRS cards from lesson vocabulary ─────────────

/**
 * Look up a vocabulary entry by Spanish word.
 */
function findVocabByWord(word: string): number | null {
  const db = getDb();
  const result = db.exec(
    `SELECT id FROM vocabulary WHERE LOWER(spanish) = LOWER('${escapeSql(word)}') LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return result[0].values[0][0] as number;
}

/**
 * Create SRS cards from a lesson's vocabulary for a list of users.
 * Respects the `content.new_cards_per_day` setting.
 */
export function createCardsFromLesson(
  lesson: DailyLesson,
  userIds: number[],
): number {
  const maxNewCards = getSetting('content.new_cards_per_day', 5) as number;
  let totalCreated = 0;

  // Find vocabulary IDs for lesson words
  const vocabIds: number[] = [];
  for (const v of lesson.vocabulary) {
    const id = findVocabByWord(v.word);
    if (id) vocabIds.push(id);
  }

  if (vocabIds.length === 0) {
    lessonLog.debug('No matching vocabulary found for lesson SRS cards');
    return 0;
  }

  // Create cards for each user (capped by maxNewCards)
  const cardsToCreate = vocabIds.slice(0, maxNewCards);
  for (const userId of userIds) {
    for (const contentId of cardsToCreate) {
      createCard(userId, 'vocab', contentId);
      totalCreated++;
    }
  }

  lessonLog.info(`Created ${totalCreated} SRS cards from lesson vocab for ${userIds.length} users`);
  return totalCreated;
}

// ── Lunfardo → SRS cards ──────────────────────────────────

/**
 * Upsert a lunfardo word into the vocabulary table and create SRS cards for all users.
 */
export function createCardsFromLunfardo(
  post: LunfardoPost,
  userIds: number[],
): number {
  const db = getDb();

  // Upsert into vocabulary (insert if not exists)
  const existing = db.exec(
    `SELECT id FROM vocabulary WHERE LOWER(spanish) = LOWER('${escapeSql(post.word)}') LIMIT 1`,
  );

  let vocabId: number;
  if (existing.length && existing[0].values.length) {
    vocabId = existing[0].values[0][0] as number;
  } else {
    db.run(
      `INSERT INTO vocabulary (spanish, english, category, difficulty, example_sentence, is_lunfardo, etymology)
       VALUES ('${escapeSql(post.word)}', '${escapeSql(post.meaning_en)}', '${escapeSql(post.category)}', 3, ${post.examples[0] ? `'${escapeSql(post.examples[0])}'` : 'NULL'}, 1, ${post.etymology ? `'${escapeSql(post.etymology)}'` : 'NULL'})`,
    );
    const result = db.exec('SELECT last_insert_rowid()');
    vocabId = (result[0]?.values[0]?.[0] as number) ?? 0;
    lessonLog.info(`Inserted lunfardo word "${post.word}" into vocabulary (id=${vocabId})`);
  }

  if (!vocabId) return 0;

  let created = 0;
  for (const userId of userIds) {
    createCard(userId, 'vocab', vocabId);
    created++;
  }

  lessonLog.info(`Created ${created} SRS cards from lunfardo "${post.word}" for ${userIds.length} users`);
  return created;
}

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
