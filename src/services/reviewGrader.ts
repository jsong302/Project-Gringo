/**
 * Review Grader — LLM-powered grading for voice/text responses.
 *
 * Uses the grade_voice_response prompt to evaluate student answers.
 * Returns a quality score (0-5) and feedback for SM-2 updates.
 */
import { callLlm } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { parseLlmJson } from './lessonEngine';
import { log } from '../utils/logger';
import { getSetting } from './settings';
import type { CardContent } from './cardContent';

const gradeLog = log.withScope('grader');

// ── Types ───────────────────────────────────────────────────

export interface GradeResult {
  quality: number;        // 0-5 for SM-2
  correct: 'yes' | 'partial' | 'no';
  errors: GradeError[];
  praise: string;
  suggestion: string;
  responseEs: string;     // Full Spanish response to show the student
}

export interface GradeError {
  type: 'grammar' | 'vocab' | 'conjugation' | 'pronunciation';
  description: string;
  correction: string;
}

// ── Raw LLM response shape ──────────────────────────────────

interface RawGradeResponse {
  correct: string;
  score: number;
  errors: Array<{ type: string; description: string; correction: string }>;
  praise: string;
  suggestion: string;
  response_es: string;
}

// ── Grading ─────────────────────────────────────────────────

export async function gradeResponse(
  content: CardContent,
  userResponse: string,
  userLevel: number,
): Promise<GradeResult> {
  const promptTemplate = getPromptOrThrow('grade_voice_response');

  const system = interpolate(promptTemplate, {
    level: String(userLevel),
    exercise: content.front,
    transcript: userResponse,
  });

  const response = await callLlm({
    system,
    messages: [{ role: 'user', content: userResponse }],
    maxTokens: 512,
    temperature: getSetting('llm.grading_temperature', 0.3),
  });

  const parsed = parseGradeResponse(response.text);
  gradeLog.debug(`Graded: quality=${parsed.quality} correct=${parsed.correct}`);
  return parsed;
}

/**
 * Parse the LLM's JSON grade response into a GradeResult.
 * Exported for unit testing.
 */
export function parseGradeResponse(text: string): GradeResult {
  const raw = parseLlmJson<RawGradeResponse>(text);

  // Normalize "correct" field
  const correct = normalizeCorrect(raw.correct);

  // Clamp score to 0-5
  const score = Math.max(0, Math.min(5, Math.round(raw.score ?? 0)));

  // Map LLM score to SM-2 quality
  const quality = score;

  const errors: GradeError[] = (raw.errors ?? []).map((e) => ({
    type: normalizeErrorType(e.type),
    description: e.description ?? '',
    correction: e.correction ?? '',
  }));

  return {
    quality,
    correct,
    errors,
    praise: raw.praise ?? '',
    suggestion: raw.suggestion ?? '',
    responseEs: raw.response_es ?? '',
  };
}

function normalizeCorrect(value: string): 'yes' | 'partial' | 'no' {
  const lower = (value ?? '').toLowerCase();
  if (lower === 'yes' || lower === 'sí' || lower === 'si') return 'yes';
  if (lower === 'partial' || lower === 'parcial') return 'partial';
  return 'no';
}

function normalizeErrorType(type: string): GradeError['type'] {
  const lower = (type ?? '').toLowerCase();
  if (lower === 'grammar' || lower === 'gramática') return 'grammar';
  if (lower === 'vocab' || lower === 'vocabulary' || lower === 'vocabulario') return 'vocab';
  if (lower === 'conjugation' || lower === 'conjugación') return 'conjugation';
  if (lower === 'pronunciation' || lower === 'pronunciación') return 'pronunciation';
  return 'grammar'; // Default fallback
}

// ── Feedback formatting ─────────────────────────────────────

export function formatGradeFeedbackBlocks(grade: GradeResult): object[] {
  const emoji = grade.correct === 'yes' ? '✅' : grade.correct === 'partial' ? '🟡' : '❌';

  const blocks: object[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${grade.correct === 'yes' ? 'Correcto!' : grade.correct === 'partial' ? 'Casi...' : 'Incorrecto'}* (${grade.quality}/5)`,
      },
    },
  ];

  if (grade.praise) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `👏 ${grade.praise}` },
    });
  }

  if (grade.errors.length > 0) {
    const errorLines = grade.errors.map(
      (e) => `• *${e.type}*: ${e.description} → _${e.correction}_`,
    );
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `📝 *Correcciones:*\n${errorLines.join('\n')}` },
    });
  }

  if (grade.suggestion) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `💡 ${grade.suggestion}` }],
    });
  }

  if (grade.responseEs) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🤖 _${grade.responseEs}_` },
    });
  }

  return blocks;
}
