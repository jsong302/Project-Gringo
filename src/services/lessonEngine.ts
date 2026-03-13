import { callLlm } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { getDb } from '../db';
import { log } from '../utils/logger';

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
        text: `*Tema:*\n${lesson.grammar_topic}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Vocabulario:*\n${vocabLines}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🎙️ Ejercicio:*\n${lesson.exercise}\n\n_Respondé con un audio en el hilo._`,
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🇦🇷 *Dato cultural:* ${lesson.cultural_note}`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Nivel: ${'⭐'.repeat(lesson.difficulty)}`,
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
        text: `🗣️ Lunfardo del día: ${post.word}`,
        emoji: true,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*En español:* ${post.meaning_es}\n*In English:* ${post.meaning_en}${vesreLine}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Etimología:* ${post.etymology}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Ejemplos:*\n${exampleLines}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Categoría: *${post.category}*`,
        },
      ],
    },
  ];
}

// ── Lesson generation ───────────────────────────────────────

export async function generateDailyLesson(level: number): Promise<{
  lesson: DailyLesson;
  blocks: any[];
}> {
  const promptTemplate = getPromptOrThrow('daily_lesson');
  const prompt = interpolate(promptTemplate, { level: String(level) });

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

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
