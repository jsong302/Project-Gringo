/**
 * Exit Exam — end-of-level tests that gate level advancement.
 *
 * Each level (1-4) has a question bank of pre-generated questions.
 * When a user finishes all units in a level, they take an exit exam:
 * a random subset of questions from the bank. They must pass (70%)
 * to advance to the next level.
 *
 * Question types:
 * - mc: multiple choice (graded deterministically)
 * - fill_blank: fill in the blank (fuzzy match against accepted answers)
 * - translation: translate a sentence (graded by LLM)
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import { callLlm } from './llm';
import { getSetting } from './settings';
import { getCurriculum } from './curriculum';

const examLog = log.withScope('exit-exam');

// ── Types ───────────────────────────────────────────────────

export interface ExitExamQuestion {
  id: number;
  levelBand: number;
  sourceUnitId: number | null;
  questionType: 'mc' | 'fill_blank' | 'translation';
  questionText: string;
  options: string[] | null;       // MC only
  correctIndex: number | null;    // MC only
  answers: string[] | null;       // fill_blank accepted answers
  translationDirection: 'en_to_es' | 'es_to_en' | null;
  referenceAnswer: string | null; // translation reference
}

export interface ExamAnswer {
  questionId: number;
  answer: string;
  correct: boolean;
  score: number;        // 0 or 1
  feedback: string;
}

export interface ExitExamState {
  userId: number;
  slackUserId: string;
  levelBand: number;
  questions: ExitExamQuestion[];
  currentIndex: number;
  answers: ExamAnswer[];
  showingFeedback: boolean;
  lastFeedback: { correct: boolean; feedback: string } | null;
  completed: boolean;
  passed: boolean;
}

export interface ExamAnswerResult {
  correct: boolean;
  feedback: string;
  testComplete: boolean;
  passed: boolean;
  totalCorrect: number;
  totalQuestions: number;
}

// ── In-memory store (keyed by slackUserId) ──────────────────

const activeExams = new Map<string, ExitExamState>();

export function getActiveExam(slackUserId: string): ExitExamState | undefined {
  return activeExams.get(slackUserId);
}

export function clearActiveExam(slackUserId: string): void {
  activeExams.delete(slackUserId);
}

// ── Question bank DB operations ─────────────────────────────

function rowToQuestion(row: unknown[]): ExitExamQuestion {
  return {
    id: row[0] as number,
    levelBand: row[1] as number,
    sourceUnitId: row[2] as number | null,
    questionType: row[3] as 'mc' | 'fill_blank' | 'translation',
    questionText: row[4] as string,
    options: row[5] ? JSON.parse(row[5] as string) : null,
    correctIndex: row[6] as number | null,
    answers: row[7] ? JSON.parse(row[7] as string) : null,
    translationDirection: row[8] as 'en_to_es' | 'es_to_en' | null,
    referenceAnswer: row[9] as string | null,
  };
}

export function getQuestionsForLevel(levelBand: number): ExitExamQuestion[] {
  const db = getDb();
  const result = db.exec(
    `SELECT id, level_band, source_unit_id, question_type, question_text,
            options_json, correct_index, answers_json, translation_direction, reference_answer
     FROM exit_exam_questions
     WHERE level_band = ${levelBand} AND status = 'active'`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToQuestion);
}

export function getQuestionBankStats(): { levelBand: number; count: number }[] {
  const db = getDb();
  const result = db.exec(
    `SELECT level_band, COUNT(*) as cnt
     FROM exit_exam_questions WHERE status = 'active'
     GROUP BY level_band ORDER BY level_band`,
  );
  if (!result.length) return [];
  return result[0].values.map(row => ({
    levelBand: row[0] as number,
    count: row[1] as number,
  }));
}

export function getQuestionCountForLevel(levelBand: number): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM exit_exam_questions WHERE level_band = ${levelBand} AND status = 'active'`,
  );
  if (!result.length) return 0;
  return result[0].values[0][0] as number;
}

export function insertQuestion(
  levelBand: number,
  sourceUnitId: number | null,
  questionType: 'mc' | 'fill_blank' | 'translation',
  questionText: string,
  options: string[] | null,
  correctIndex: number | null,
  answers: string[] | null,
  translationDirection: 'en_to_es' | 'es_to_en' | null,
  referenceAnswer: string | null,
): void {
  const db = getDb();
  const esc = (s: string) => s.replace(/'/g, "''");
  const optJson = options ? `'${esc(JSON.stringify(options))}'` : 'NULL';
  const ansJson = answers ? `'${esc(JSON.stringify(answers))}'` : 'NULL';
  const ci = correctIndex !== null ? correctIndex : 'NULL';
  const sui = sourceUnitId ?? 'NULL';
  const td = translationDirection ? `'${translationDirection}'` : 'NULL';
  const ra = referenceAnswer ? `'${esc(referenceAnswer)}'` : 'NULL';

  db.run(
    `INSERT INTO exit_exam_questions (level_band, source_unit_id, question_type, question_text,
       options_json, correct_index, answers_json, translation_direction, reference_answer)
     VALUES (${levelBand}, ${sui}, '${questionType}', '${esc(questionText)}',
       ${optJson}, ${ci}, ${ansJson}, ${td}, ${ra})`,
  );
}

export function archiveQuestion(questionId: number): void {
  const db = getDb();
  db.run(`UPDATE exit_exam_questions SET status = 'archived' WHERE id = ${questionId}`);
}

export function clearQuestionsForLevel(levelBand: number): number {
  const db = getDb();
  const countResult = db.exec(
    `SELECT COUNT(*) FROM exit_exam_questions WHERE level_band = ${levelBand} AND status = 'active'`,
  );
  const count = countResult.length ? (countResult[0].values[0][0] as number) : 0;
  db.run(`DELETE FROM exit_exam_questions WHERE level_band = ${levelBand}`);
  return count;
}

// ── Start an exit exam ──────────────────────────────────────

const EXAM_QUESTION_COUNT = 15;

export function startExitExam(userId: number, slackUserId: string, levelBand: number): ExitExamState | null {
  const allQuestions = getQuestionsForLevel(levelBand);
  if (allQuestions.length < 5) {
    examLog.warn(`Not enough questions for level ${levelBand} exam (${allQuestions.length} available)`);
    return null;
  }

  // Select random subset with unit coverage
  const selected = selectQuestionsWithCoverage(allQuestions, Math.min(EXAM_QUESTION_COUNT, allQuestions.length));

  const state: ExitExamState = {
    userId,
    slackUserId,
    levelBand,
    questions: selected,
    currentIndex: 0,
    answers: [],
    showingFeedback: false,
    lastFeedback: null,
    completed: false,
    passed: false,
  };

  activeExams.set(slackUserId, state);
  examLog.info(`Started exit exam for level ${levelBand}: ${slackUserId} (${selected.length} questions)`);
  return state;
}

/**
 * Select questions ensuring coverage across source units.
 * Takes at least 1 from each unit represented, fills rest randomly.
 */
function selectQuestionsWithCoverage(questions: ExitExamQuestion[], count: number): ExitExamQuestion[] {
  // Group by source unit
  const byUnit = new Map<number | null, ExitExamQuestion[]>();
  for (const q of questions) {
    const key = q.sourceUnitId;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key)!.push(q);
  }

  const selected: ExitExamQuestion[] = [];
  const usedIds = new Set<number>();

  // One from each unit
  for (const [, unitQuestions] of byUnit) {
    if (selected.length >= count) break;
    const shuffled = [...unitQuestions].sort(() => Math.random() - 0.5);
    selected.push(shuffled[0]);
    usedIds.add(shuffled[0].id);
  }

  // Fill remaining randomly from unused questions
  const remaining = questions.filter(q => !usedIds.has(q.id));
  const shuffledRemaining = [...remaining].sort(() => Math.random() - 0.5);
  for (const q of shuffledRemaining) {
    if (selected.length >= count) break;
    selected.push(q);
  }

  // Shuffle final selection
  return selected.sort(() => Math.random() - 0.5);
}

// ── Process an answer ───────────────────────────────────────

export async function processExamAnswer(
  slackUserId: string,
  answer: string | number,
): Promise<ExamAnswerResult | null> {
  const state = activeExams.get(slackUserId);
  if (!state || state.completed) return null;

  const question = state.questions[state.currentIndex];
  let correct = false;
  let feedback = '';

  switch (question.questionType) {
    case 'mc': {
      const selectedIdx = typeof answer === 'number' ? answer : parseInt(answer, 10);
      correct = selectedIdx === question.correctIndex;
      const correctOption = question.options?.[question.correctIndex ?? 0] ?? '';
      feedback = correct
        ? 'Correct!'
        : `Incorrect. The answer is: *${correctOption}*`;
      break;
    }

    case 'fill_blank': {
      const userAnswer = String(answer).trim().toLowerCase();
      const accepted = (question.answers ?? []).map(a => a.toLowerCase());
      // Fuzzy: strip accents for comparison
      const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      correct = accepted.some(a => normalize(a) === normalize(userAnswer));
      const correctAnswer = question.answers?.[0] ?? '';
      feedback = correct
        ? 'Correct!'
        : `Incorrect. Accepted answer: *${correctAnswer}*`;
      break;
    }

    case 'translation': {
      const result = await gradeTranslation(question, String(answer));
      correct = result.correct;
      feedback = result.feedback;
      break;
    }
  }

  state.answers.push({
    questionId: question.id,
    answer: String(answer),
    correct,
    score: correct ? 1 : 0,
    feedback,
  });

  state.showingFeedback = true;
  state.lastFeedback = { correct, feedback };
  state.currentIndex++;

  // Check if exam is complete
  if (state.currentIndex >= state.questions.length) {
    state.completed = true;
    const totalCorrect = state.answers.filter(a => a.correct).length;
    const passThreshold = parseFloat(getSetting('exit_exam.pass_threshold', '0.7'));
    state.passed = (totalCorrect / state.questions.length) >= passThreshold;

    saveExamResult(state);
    examLog.info(`Exit exam complete for ${slackUserId}: ${totalCorrect}/${state.questions.length} (${state.passed ? 'PASSED' : 'FAILED'})`);

    return {
      correct,
      feedback,
      testComplete: true,
      passed: state.passed,
      totalCorrect,
      totalQuestions: state.questions.length,
    };
  }

  return {
    correct,
    feedback,
    testComplete: false,
    passed: false,
    totalCorrect: state.answers.filter(a => a.correct).length,
    totalQuestions: state.questions.length,
  };
}

// ── Translation grading via LLM ─────────────────────────────

async function gradeTranslation(
  question: ExitExamQuestion,
  userAnswer: string,
): Promise<{ correct: boolean; feedback: string }> {
  try {
    const direction = question.translationDirection === 'en_to_es'
      ? 'English to Spanish' : 'Spanish to English';

    const response = await callLlm({
      system: `You grade Spanish translation exercises. The student is translating ${direction}.
Accept minor spelling mistakes, missing accents, and alternate valid translations.
Use Argentine Spanish (voseo) as the standard.
Respond with ONLY a JSON object: {"correct": true/false, "feedback": "brief feedback"}`,
      messages: [{
        role: 'user',
        content: `Question: ${question.questionText}\nReference answer: ${question.referenceAnswer}\nStudent's answer: ${userAnswer}`,
      }],
      temperature: 0.1,
      maxTokens: 150,
    });

    const cleaned = response.text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      correct: !!parsed.correct,
      feedback: parsed.feedback || (parsed.correct ? 'Correct!' : `Expected: *${question.referenceAnswer}*`),
    };
  } catch (err) {
    examLog.error(`Translation grading failed: ${err}`);
    // Fallback: simple string comparison
    const normalize = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const correct = normalize(userAnswer) === normalize(question.referenceAnswer ?? '');
    return {
      correct,
      feedback: correct ? 'Correct!' : `Expected: *${question.referenceAnswer}*`,
    };
  }
}

// ── Persist exam results ────────────────────────────────────

function saveExamResult(state: ExitExamState): void {
  const db = getDb();
  const esc = (s: string) => s.replace(/'/g, "''");
  const totalCorrect = state.answers.filter(a => a.correct).length;
  const questionsJson = esc(JSON.stringify(state.answers));

  db.run(
    `INSERT INTO exit_exam_attempts (user_id, level_band, questions_json, total_correct, total_questions, passed)
     VALUES (${state.userId}, ${state.levelBand}, '${questionsJson}', ${totalCorrect}, ${state.questions.length}, ${state.passed ? 1 : 0})`,
  );
}

// ── Query helpers ───────────────────────────────────────────

export function hasPassedExitExam(userId: number, levelBand: number): boolean {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM exit_exam_attempts
     WHERE user_id = ${userId} AND level_band = ${levelBand} AND passed = 1`,
  );
  if (!result.length) return false;
  return (result[0].values[0][0] as number) > 0;
}

export function getExamAttemptCount(userId: number, levelBand: number): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM exit_exam_attempts
     WHERE user_id = ${userId} AND level_band = ${levelBand}`,
  );
  if (!result.length) return 0;
  return result[0].values[0][0] as number;
}

export function getExamAttempts(userId: number): { levelBand: number; passed: boolean; totalCorrect: number; totalQuestions: number; createdAt: string }[] {
  const db = getDb();
  const result = db.exec(
    `SELECT level_band, passed, total_correct, total_questions, created_at
     FROM exit_exam_attempts WHERE user_id = ${userId} ORDER BY created_at DESC`,
  );
  if (!result.length) return [];
  return result[0].values.map(row => ({
    levelBand: row[0] as number,
    passed: (row[1] as number) === 1,
    totalCorrect: row[2] as number,
    totalQuestions: row[3] as number,
    createdAt: row[4] as string,
  }));
}

/**
 * Check if a user needs an exit exam to advance past their current level.
 * Returns the level band they need to pass, or null if no exam needed.
 */
export function getPendingExitExam(userId: number, currentLevelBand: number): number | null {
  // Only levels 1-4 have exit exams (level 5 is the final level)
  if (currentLevelBand >= 5) return null;

  // Check if there are enough questions for this level
  const count = getQuestionCountForLevel(currentLevelBand);
  if (count < 5) return null;

  // Check if they've already passed
  if (hasPassedExitExam(userId, currentLevelBand)) return null;

  // Check if ALL units in this level are passed
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM user_curriculum_progress ucp
     JOIN curriculum_units cu ON ucp.unit_id = cu.id
     WHERE ucp.user_id = ${userId} AND cu.level_band = ${currentLevelBand}
       AND cu.status = 'active' AND ucp.status != 'passed' AND ucp.status != 'skipped'`,
  );
  const unfinished = result.length ? (result[0].values[0][0] as number) : 0;
  if (unfinished > 0) return null; // Still has units to complete in this level

  return currentLevelBand;
}
