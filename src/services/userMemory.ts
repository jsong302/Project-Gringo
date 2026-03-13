/**
 * User Memory — AI-generated learner profiles.
 *
 * The LLM periodically summarizes a user's strengths, weaknesses,
 * interests, and common errors into a profile stored in user_memory.
 * This profile is injected into charla and grading prompts for
 * personalized teaching.
 */
import { getDb } from '../db';
import { callLlm } from './llm';
import { getRecentErrors, getErrorSummary } from './errorTracker';
import { getUserCardStats } from './srsRepository';
import { getUserById } from './userService';
import { getLearnerFacts } from './learnerFacts';
import { log } from '../utils/logger';

const memLog = log.withScope('memory');

// ── Types ───────────────────────────────────────────────────

export interface UserMemory {
  id: number;
  userId: number;
  profileSummary: string;
  strengths: string | null;
  weaknesses: string | null;
  interests: string | null;
  pronunciationNotes: string | null;
  interactionCountAtGeneration: number;
  generatedAt: string;
}

// ── CRUD ────────────────────────────────────────────────────

export function getMemory(userId: number): UserMemory | null {
  const db = getDb();
  const result = db.exec(`SELECT * FROM user_memory WHERE user_id = ${userId}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToMemory(result[0].values[0]);
}

export function upsertMemory(
  userId: number,
  summary: string,
  strengths?: string,
  weaknesses?: string,
  interests?: string,
  pronunciationNotes?: string,
  interactionCount?: number,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO user_memory (user_id, profile_summary, strengths, weaknesses, interests, pronunciation_notes, interaction_count_at_generation)
     VALUES (${userId}, '${esc(summary)}',
             ${strengths ? `'${esc(strengths)}'` : 'NULL'},
             ${weaknesses ? `'${esc(weaknesses)}'` : 'NULL'},
             ${interests ? `'${esc(interests)}'` : 'NULL'},
             ${pronunciationNotes ? `'${esc(pronunciationNotes)}'` : 'NULL'},
             ${interactionCount ?? 0})
     ON CONFLICT(user_id) DO UPDATE SET
       profile_summary = excluded.profile_summary,
       strengths = excluded.strengths,
       weaknesses = excluded.weaknesses,
       interests = excluded.interests,
       pronunciation_notes = excluded.pronunciation_notes,
       interaction_count_at_generation = excluded.interaction_count_at_generation,
       generated_at = datetime('now')`,
  );
  memLog.info(`Memory updated for user ${userId}`);
}

// ── Memory generation ───────────────────────────────────────

/**
 * Build context for the LLM to generate a user profile.
 * Exported for testing.
 */
export function buildMemoryContext(userId: number): string {
  const user = getUserById(userId);
  if (!user) return '';

  const errors = getRecentErrors(userId, 30);
  const errorSummary = getErrorSummary(userId);
  const cardStats = getUserCardStats(userId);

  const parts: string[] = [];

  const nameLabel = user.displayName ? `${user.displayName}, ` : '';
  parts.push(`Student: ${nameLabel}level ${user.level}, ${user.xp} XP, ${user.streakDays}-day streak`);
  parts.push(`SRS: ${cardStats.total} cards (${cardStats.learning} learning, ${cardStats.reviewing} reviewing, ${cardStats.due} due)`);

  if (errorSummary.length > 0) {
    parts.push(`Error distribution: ${errorSummary.map((e) => `${e.category}: ${e.count}`).join(', ')}`);
  }

  if (errors.length > 0) {
    parts.push('Recent errors:');
    for (const err of errors.slice(0, 10)) {
      let line = `- [${err.errorCategory}] ${err.description}`;
      if (err.userSaid) line += ` (said: "${err.userSaid}")`;
      if (err.correction) line += ` → ${err.correction}`;
      parts.push(line);
    }
  }

  // Include learner facts from tool-based observation
  const facts = getLearnerFacts(userId, 30);
  if (facts.length > 0) {
    parts.push('Observed facts:');
    for (const f of facts) {
      parts.push(`- [${f.category}] ${f.fact}`);
    }
  }

  return parts.join('\n');
}

/**
 * Generate (or regenerate) a user's memory profile via LLM.
 */
export async function generateMemory(userId: number): Promise<UserMemory> {
  const context = buildMemoryContext(userId);

  const response = await callLlm({
    system: `You are analyzing a Spanish language student's learning data to create a brief learner profile.

Based on the data below, write a JSON response with:
- "summary": 2-3 sentence overview of the student (level, pace, tendencies)
- "strengths": what they're good at (comma-separated)
- "weaknesses": what they struggle with (comma-separated)
- "interests": topics they seem interested in (comma-separated, or null)
- "pronunciation_notes": any pronunciation patterns noted (or null)

Be specific and actionable. This profile will be used to personalize their lessons.

Student data:
${context}`,
    messages: [{ role: 'user', content: 'Generate the learner profile.' }],
    temperature: 0.3,
    maxTokens: 512,
  });

  // Parse response
  let parsed: any;
  try {
    const cleaned = response.text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: use raw text as summary
    parsed = { summary: response.text.slice(0, 500) };
  }

  upsertMemory(
    userId,
    parsed.summary ?? response.text.slice(0, 500),
    parsed.strengths ?? undefined,
    parsed.weaknesses ?? undefined,
    parsed.interests ?? undefined,
    parsed.pronunciation_notes ?? undefined,
  );

  memLog.info(`Generated memory for user ${userId}`);
  return getMemory(userId)!;
}

/**
 * Get the memory context string to inject into prompts.
 * Returns empty string if no memory exists.
 */
export function getMemoryForPrompt(userId: number): string {
  const memory = getMemory(userId);
  if (!memory) return '';

  const parts = [`Learner profile: ${memory.profileSummary}`];
  if (memory.strengths) parts.push(`Strengths: ${memory.strengths}`);
  if (memory.weaknesses) parts.push(`Weaknesses: ${memory.weaknesses}`);
  if (memory.interests) parts.push(`Interests: ${memory.interests}`);
  if (memory.pronunciationNotes) parts.push(`Pronunciation: ${memory.pronunciationNotes}`);

  return parts.join('\n');
}

// ── Row mapper ──────────────────────────────────────────────

function rowToMemory(row: unknown[]): UserMemory {
  return {
    id: row[0] as number,
    userId: row[1] as number,
    profileSummary: row[2] as string,
    strengths: row[3] as string | null,
    weaknesses: row[4] as string | null,
    interests: row[5] as string | null,
    pronunciationNotes: row[6] as string | null,
    interactionCountAtGeneration: row[7] as number,
    generatedAt: row[8] as string,
  };
}

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
