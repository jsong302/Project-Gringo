/**
 * Lesson Plan Service — personalized curriculum per user.
 *
 * On onboarding, the LLM generates a ~12-15 topic curriculum for the
 * student's level. At daily lesson time, the LLM uses the plan + learner
 * profile to decide what to teach next (it can follow the plan order,
 * revisit weak areas, or insert new topics).
 *
 * `/gringo plan` shows the student their progress.
 */
import { getDb } from '../db';
import { callLlm } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { log } from '../utils/logger';

const planLog = log.withScope('lesson-plan');

// ── Types ───────────────────────────────────────────────────

export interface LessonPlanTopic {
  id: number;
  userId: number;
  topicOrder: number;
  topic: string;
  title: string;
  description: string | null;
  status: 'pending' | 'active' | 'completed' | 'skipped';
  completedAt: string | null;
  createdAt: string;
}

// ── CRUD ────────────────────────────────────────────────────

export function getUserPlan(userId: number): LessonPlanTopic[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM lesson_plans WHERE user_id = ${userId} ORDER BY topic_order ASC`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToTopic);
}

export function getActiveTopic(userId: number): LessonPlanTopic | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM lesson_plans WHERE user_id = ${userId} AND status = 'active' ORDER BY topic_order ASC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToTopic(result[0].values[0]);
}

export function getNextPendingTopic(userId: number): LessonPlanTopic | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM lesson_plans WHERE user_id = ${userId} AND status = 'pending' ORDER BY topic_order ASC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToTopic(result[0].values[0]);
}

export function completeTopic(topicId: number): void {
  const db = getDb();
  db.run(
    `UPDATE lesson_plans SET status = 'completed', completed_at = datetime('now') WHERE id = ${topicId}`,
  );
  planLog.info(`Topic ${topicId} completed`);
}

export function activateTopic(topicId: number): void {
  const db = getDb();
  db.run(
    `UPDATE lesson_plans SET status = 'active' WHERE id = ${topicId}`,
  );
  planLog.info(`Topic ${topicId} activated`);
}

export function advanceToNextTopic(userId: number): LessonPlanTopic | null {
  const active = getActiveTopic(userId);
  if (active) {
    completeTopic(active.id);
  }
  const next = getNextPendingTopic(userId);
  if (next) {
    activateTopic(next.id);
    return next;
  }
  return null;
}

export function skipTopic(topicId: number): void {
  const db = getDb();
  db.run(
    `UPDATE lesson_plans SET status = 'skipped' WHERE id = ${topicId}`,
  );
}

export function hasPlan(userId: number): boolean {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM lesson_plans WHERE user_id = ${userId}`,
  );
  return ((result[0]?.values[0]?.[0] as number) ?? 0) > 0;
}

export function deletePlan(userId: number): void {
  const db = getDb();
  db.run(`DELETE FROM lesson_plans WHERE user_id = ${userId}`);
  planLog.info(`Plan deleted for user ${userId}`);
}

// ── Plan generation ─────────────────────────────────────────

export async function generatePlan(userId: number, level: number): Promise<LessonPlanTopic[]> {
  // Delete any existing plan
  deletePlan(userId);

  const promptTemplate = getPromptOrThrow('generate_lesson_plan');
  const prompt = interpolate(promptTemplate, { level: String(level) });

  const response = await callLlm({
    system: prompt,
    messages: [{ role: 'user', content: 'Generate the lesson plan.' }],
    temperature: 0.5,
    maxTokens: 2048,
  });

  // Parse JSON response
  let topics: { topic: string; title: string; description: string }[];
  try {
    let cleaned = response.text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    topics = JSON.parse(cleaned);
  } catch (err) {
    planLog.error(`Failed to parse lesson plan for user ${userId}: ${err}`);
    // Fallback: generate a basic plan
    topics = getDefaultTopics(level);
  }

  // Insert into DB
  const db = getDb();
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const status = i === 0 ? 'active' : 'pending';
    db.run(
      `INSERT INTO lesson_plans (user_id, topic_order, topic, title, description, status)
       VALUES (${userId}, ${i + 1}, '${esc(t.topic)}', '${esc(t.title)}', '${esc(t.description ?? '')}', '${status}')`,
    );
  }

  planLog.info(`Generated ${topics.length}-topic plan for user ${userId} (level ${level})`);
  return getUserPlan(userId);
}

// ── Plan context for prompts ────────────────────────────────

/**
 * Build a context string describing the user's plan for injection into
 * the daily lesson prompt. Tells the LLM what topic is active, what's
 * been covered, and what's coming next.
 */
export function getPlanContext(userId: number): string {
  const plan = getUserPlan(userId);
  if (plan.length === 0) return '';

  const completed = plan.filter((t) => t.status === 'completed');
  const active = plan.find((t) => t.status === 'active');
  const upcoming = plan.filter((t) => t.status === 'pending').slice(0, 3);

  const parts: string[] = ['Lesson plan:'];

  if (completed.length > 0) {
    parts.push(`Completed (${completed.length}/${plan.length}): ${completed.map((t) => t.title).join(', ')}`);
  }

  if (active) {
    parts.push(`Current topic: "${active.title}" — ${active.description ?? ''}`);
    parts.push('Generate today\'s lesson on this topic. If the student has shown mastery, you can move to the next topic instead.');
  }

  if (upcoming.length > 0) {
    parts.push(`Coming up: ${upcoming.map((t) => t.title).join(', ')}`);
  }

  return parts.join('\n');
}

// ── Formatting for /gringo plan ─────────────────────────────

export function formatPlanBlocks(plan: LessonPlanTopic[]): object[] {
  const total = plan.length;
  const completed = plan.filter((t) => t.status === 'completed').length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  const progressBar = buildProgressBar(completed, total);

  const topicLines = plan.map((t) => {
    const icon = t.status === 'completed' ? ':white_check_mark:'
      : t.status === 'active' ? ':arrow_forward:'
      : t.status === 'skipped' ? ':fast_forward:'
      : ':radio_button:';
    const suffix = t.status === 'active' ? ' _(current)_' : '';
    return `${icon}  *${t.title}*${suffix}`;
  });

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Your Lesson Plan' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${progressBar}  ${completed}/${total} topics completed (${percentage}%)`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: topicLines.join('\n'),
      },
    },
  ];
}

function buildProgressBar(completed: number, total: number): string {
  const filled = total > 0 ? Math.round((completed / total) * 10) : 0;
  const empty = 10 - filled;
  return ':large_green_square:'.repeat(filled) + ':white_large_square:'.repeat(empty);
}

// ── Fallback topics ─────────────────────────────────────────

function getDefaultTopics(level: number): { topic: string; title: string; description: string }[] {
  const plans: Record<number, { topic: string; title: string; description: string }[]> = {
    1: [
      { topic: 'greetings', title: 'Greetings & Introductions', description: 'Hola, me llamo..., mucho gusto — the basics for meeting people.' },
      { topic: 'numbers_time', title: 'Numbers & Telling Time', description: 'Counting, prices, schedules — essential for daily life.' },
      { topic: 'basic_verbs', title: 'Ser, Estar, Tener with Voseo', description: 'The three most important verbs in Argentine Spanish.' },
      { topic: 'food_ordering', title: 'Ordering Food & Drinks', description: 'Restaurant and cafe vocabulary — empanadas, mate, medialunas.' },
      { topic: 'directions', title: 'Asking for Directions', description: 'Getting around Buenos Aires — subte, colectivo, street vocab.' },
      { topic: 'shopping', title: 'Shopping & Markets', description: 'Buying things at ferias and kioscos — prices, bargaining, sizes.' },
      { topic: 'basic_testimony', title: 'Sharing a Simple Testimony', description: 'Basic phrases for talking about faith: Dios, iglesia, orar.' },
      { topic: 'daily_routine', title: 'Daily Routine', description: 'Describing your day with reflexive verbs — levantarse, ducharse.' },
      { topic: 'family_relationships', title: 'Family & Relationships', description: 'Talking about your family and asking about theirs.' },
      { topic: 'basic_prayer', title: 'Simple Prayers', description: 'Basic prayer vocabulary and structure for praying with someone.' },
      { topic: 'emergency_phrases', title: 'Emergency & Health', description: 'Doctor, pharmacy, help — phrases you hope not to need but should know.' },
      { topic: 'farewells_plans', title: 'Making Plans & Saying Goodbye', description: 'Future plans, promises to stay in touch, warm Argentine farewells.' },
    ],
    2: [
      { topic: 'deeper_introductions', title: 'Deeper Introductions', description: 'Talking about your job, hobbies, and why you came to Argentina.' },
      { topic: 'past_tense_basics', title: 'Talking About the Past', description: 'Preterite tense — what you did yesterday, where you traveled.' },
      { topic: 'argentine_food_culture', title: 'Argentine Food Culture', description: 'Asado, mate rituals, sobremesa — food as social glue.' },
      { topic: 'public_transport', title: 'Using Public Transport', description: 'Subte, colectivo, SUBE card — getting around like a local.' },
      { topic: 'sharing_faith', title: 'Sharing Your Faith Story', description: 'Telling someone why faith matters to you in simple Spanish.' },
      { topic: 'feelings_opinions', title: 'Expressing Feelings & Opinions', description: 'Me gusta, me parece, creo que — having real opinions in Spanish.' },
      { topic: 'church_vocabulary', title: 'At Church', description: 'Worship service vocabulary — culto, alabanza, predicar, oracion.' },
      { topic: 'weather_small_talk', title: 'Small Talk & Weather', description: 'The art of Argentine small talk — mate, weather, futbol.' },
      { topic: 'invitations', title: 'Inviting & Being Invited', description: 'Accepting invitations, visiting homes, Argentine hospitality.' },
      { topic: 'prayer_conversation', title: 'Praying With Someone', description: 'Leading and participating in prayer in Spanish.' },
      { topic: 'storytelling', title: 'Telling Stories', description: 'Narrating events with past tense — connecting sentences naturally.' },
      { topic: 'review_speaking', title: 'Full Conversation Practice', description: 'Putting it all together — a simulated real encounter.' },
    ],
  };

  // For levels 3-5, return level 2 as fallback (LLM should generate these)
  return plans[level] ?? plans[2] ?? plans[1];
}

// ── Row mapper ──────────────────────────────────────────────

function rowToTopic(row: unknown[]): LessonPlanTopic {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    topicOrder: row[2] as number,
    topic: row[3] as string,
    title: row[4] as string,
    description: row[5] as string | null,
    status: row[6] as LessonPlanTopic['status'],
    completedAt: row[7] as string | null,
    createdAt: row[8] as string,
  };
}

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
