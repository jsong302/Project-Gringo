/**
 * Placement Test — adaptive multiple-choice test for onboarding.
 *
 * Flow:
 * 1. User self-assesses: "No Spanish" / "Some basics" / "Conversational" / "Advanced"
 * 2. "No Spanish" → skip, place at unit 1
 * 3. Others → run adaptive MC test within the claimed range
 * 4. Score → map to starting curriculum unit
 *
 * All questions are multiple choice (Slack buttons). No LLM needed for grading.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import { getFirstUnitForLevel, getCurriculum } from './curriculum';
import { initializeUserProgress } from './curriculumDelivery';
import { updateLevel } from './userService';

const ptLog = log.withScope('placement-test');

// ── Types ───────────────────────────────────────────────────

export interface PlacementQuestion {
  id: string;
  level: number;
  question: string;
  options: string[];
  correctIndex: number;
}

export interface PlacementState {
  userId: number;
  slackUserId: string;
  claimedLevel: number; // 1-4 based on self-assessment
  questionPool: PlacementQuestion[];
  currentQuestionIndex: number;
  answers: Array<{ question: PlacementQuestion; selectedIndex: number; correct: boolean }>;
  completed: boolean;
}

// ── Active tests (in-memory) ────────────────────────────────

const activeTests = new Map<string, PlacementState>();

export function getActiveTest(slackUserId: string): PlacementState | undefined {
  return activeTests.get(slackUserId);
}

export function clearActiveTest(slackUserId: string): void {
  activeTests.delete(slackUserId);
}

// ── Start a placement test ──────────────────────────────────

/**
 * Start a placement test for a user based on their self-assessment.
 * claimedLevel: 2 = "some basics", 3 = "conversational", 4 = "advanced"
 */
export function startPlacementTest(userId: number, slackUserId: string, claimedLevel: number): PlacementState {
  // Select questions up to claimed level
  const pool = selectQuestions(claimedLevel);

  const state: PlacementState = {
    userId,
    slackUserId,
    claimedLevel,
    questionPool: pool,
    currentQuestionIndex: 0,
    answers: [],
    completed: false,
  };

  activeTests.set(slackUserId, state);
  ptLog.info(`Started placement test for ${slackUserId} (claimed level ${claimedLevel}, ${pool.length} questions)`);
  return state;
}

/**
 * Select questions for the test based on claimed level.
 * Tests from level 1 up to claimed level.
 */
function selectQuestions(claimedLevel: number): PlacementQuestion[] {
  const selected: PlacementQuestion[] = [];

  for (let level = 1; level <= claimedLevel; level++) {
    const levelQuestions = QUESTION_POOL.filter((q) => q.level === level);
    // Pick 2-3 questions per level
    const count = level <= 2 ? 2 : 3;
    const shuffled = [...levelQuestions].sort(() => Math.random() - 0.5);
    selected.push(...shuffled.slice(0, count));
  }

  return selected;
}

// ── Process an answer ───────────────────────────────────────

export interface AnswerResult {
  correct: boolean;
  nextQuestion: PlacementQuestion | null;
  testComplete: boolean;
  placedAtUnit: number;
  derivedLevel: number;
  /** If true, user passed higher levels but failed lower ones — needs gap review */
  hasGaps: boolean;
  /** Levels the user failed (only set when hasGaps is true) */
  failedLevels: number[];
  /** Where they'd start if skipping ahead (only set when hasGaps is true) */
  skipAheadUnit: number;
  skipAheadLevel: number;
}

/**
 * Process a button answer and return the next question or final result.
 */
export function processAnswer(slackUserId: string, selectedIndex: number): AnswerResult | null {
  const state = activeTests.get(slackUserId);
  if (!state || state.completed) return null;

  const currentQuestion = state.questionPool[state.currentQuestionIndex];
  const correct = selectedIndex === currentQuestion.correctIndex;

  state.answers.push({ question: currentQuestion, selectedIndex, correct });
  state.currentQuestionIndex++;

  // Check if test is complete
  if (state.currentQuestionIndex >= state.questionPool.length) {
    state.completed = true;
    const placement = calculatePlacement(state);

    if (placement.hasGaps) {
      // Don't finalize yet — user needs to choose between filling gaps or skipping ahead
      ptLog.info(`Placement has gaps for ${slackUserId}: failed levels [${placement.failedLevels}], gap→unit ${placement.gapUnit} vs skip→unit ${placement.skipUnit}`);

      return {
        correct,
        nextQuestion: null,
        testComplete: true,
        placedAtUnit: placement.gapUnit,
        derivedLevel: placement.gapLevel,
        hasGaps: true,
        failedLevels: placement.failedLevels,
        skipAheadUnit: placement.skipUnit,
        skipAheadLevel: placement.skipLevel,
      };
    }

    // No gaps — finalize immediately
    savePlacementResult(state, placement.gapUnit, placement.gapLevel);
    initializeUserProgress(state.userId, placement.gapUnit);

    ptLog.info(`Placement complete for ${slackUserId}: unit ${placement.gapUnit}, level ${placement.gapLevel}`);
    activeTests.delete(slackUserId);

    return {
      correct,
      nextQuestion: null,
      testComplete: true,
      placedAtUnit: placement.gapUnit,
      derivedLevel: placement.gapLevel,
      hasGaps: false,
      failedLevels: [],
      skipAheadUnit: 0,
      skipAheadLevel: 0,
    };
  }

  return {
    correct,
    nextQuestion: state.questionPool[state.currentQuestionIndex],
    testComplete: false,
    placedAtUnit: 0,
    derivedLevel: 0,
    hasGaps: false,
    failedLevels: [],
    skipAheadUnit: 0,
    skipAheadLevel: 0,
  };
}

// ── Placement calculation ───────────────────────────────────

interface PlacementCalc {
  /** Unit for the conservative (gap-filling) placement */
  gapUnit: number;
  gapLevel: number;
  /** Unit for skip-ahead placement (ignore gaps) */
  skipUnit: number;
  skipLevel: number;
  /** Whether there are gaps (failed lower levels but passed higher ones) */
  hasGaps: boolean;
  failedLevels: number[];
}

function calculatePlacement(state: PlacementState): PlacementCalc {
  // Group answers by level and calculate pass rate per level
  const levelScores = new Map<number, { correct: number; total: number }>();

  for (const answer of state.answers) {
    const level = answer.question.level;
    const existing = levelScores.get(level) ?? { correct: 0, total: 0 };
    existing.total++;
    if (answer.correct) existing.correct++;
    levelScores.set(level, existing);
  }

  // Scan ALL levels (no early break) to detect gaps
  const passedLevels: number[] = [];
  const failedLevels: number[] = [];

  for (let level = 1; level <= 4; level++) {
    const scores = levelScores.get(level);
    if (!scores) continue;
    if (scores.correct / scores.total >= 0.5) {
      passedLevels.push(level);
    } else {
      failedLevels.push(level);
    }
  }

  const highestPassedLevel = passedLevels.length > 0 ? Math.max(...passedLevels) : 0;
  const lowestFailedLevel = failedLevels.length > 0 ? Math.min(...failedLevels) : 0;

  // Gaps = failed a lower level but passed a higher one
  const hasGaps = lowestFailedLevel > 0 && highestPassedLevel > lowestFailedLevel;

  const curriculum = getCurriculum();
  if (curriculum.length === 0) {
    return { gapUnit: 1, gapLevel: 1, skipUnit: 1, skipLevel: 1, hasGaps: false, failedLevels: [] };
  }

  // Conservative placement: first unit of the lowest failed level (or level 1)
  const gapPlacement = getPlacementForLevel(lowestFailedLevel > 0 ? lowestFailedLevel : 1, curriculum);

  // Skip-ahead placement: first unit of (highest passed level + 1)
  const skipPlacement = highestPassedLevel > 0
    ? getPlacementForLevel(Math.min(highestPassedLevel + 1, 4), curriculum)
    : gapPlacement;

  return {
    gapUnit: gapPlacement.unitOrder,
    gapLevel: gapPlacement.level,
    skipUnit: skipPlacement.unitOrder,
    skipLevel: skipPlacement.level,
    hasGaps,
    failedLevels: hasGaps ? failedLevels.filter((l) => l < highestPassedLevel) : [],
  };
}

function getPlacementForLevel(level: number, curriculum: ReturnType<typeof getCurriculum>): { unitOrder: number; level: number } {
  const targetUnit = getFirstUnitForLevel(level);
  if (targetUnit) {
    return { unitOrder: targetUnit.unitOrder, level: targetUnit.levelBand };
  }
  // Fallback: last unit of the previous level band
  const fallback = curriculum.filter((u) => u.levelBand < level).pop();
  if (fallback) {
    return { unitOrder: fallback.unitOrder, level: fallback.levelBand };
  }
  return { unitOrder: 1, level: 1 };
}

function savePlacementResult(state: PlacementState, unitOrder: number, level: number): void {
  const db = getDb();
  const curriculum = getCurriculum();
  const unit = curriculum.find((u) => u.unitOrder === unitOrder);
  if (!unit) return;

  const questionsJson = JSON.stringify(state.answers.map((a) => ({
    id: a.question.id,
    level: a.question.level,
    question: a.question.question,
    selected: a.selectedIndex,
    correct: a.correct,
  })));

  const resultsJson = JSON.stringify({
    totalCorrect: state.answers.filter((a) => a.correct).length,
    totalQuestions: state.answers.length,
    claimedLevel: state.claimedLevel,
  });

  db.run(
    `INSERT INTO placement_tests (user_id, questions_json, results_json, placed_at_unit, derived_level)
     VALUES (${state.userId}, '${questionsJson.replace(/'/g, "''")}', '${resultsJson.replace(/'/g, "''")}', ${unit.id}, ${level})`,
  );
}

// ── Deferred placement (gap resolution) ─────────────────────

/**
 * Finalize placement after the user chooses to fill gaps or skip ahead.
 * Called from onboarding button handlers.
 */
export function finalizePlacement(slackUserId: string, unitOrder: number, level: number): void {
  const state = activeTests.get(slackUserId);
  if (state) {
    savePlacementResult(state, unitOrder, level);
    initializeUserProgress(state.userId, unitOrder);
    updateLevel(state.userId, level);
    ptLog.info(`Gap resolution for ${slackUserId}: placed at unit ${unitOrder}, level ${level}`);
    activeTests.delete(slackUserId);
  }
}

// ── Level topic descriptions (for gap review) ────────────────

const LEVEL_TOPICS: Record<number, string> = {
  1: 'greetings, numbers, ser/estar, basic present tense',
  2: 'past tense, voseo basics, daily vocabulary, simple questions',
  3: 'subjunctive mood, lunfardo basics, expressing opinions',
  4: 'complex grammar, vesre, Argentine idioms, advanced lunfardo',
};

// ── Slack formatting ────────────────────────────────────────

export function formatGapReviewBlocks(
  failedLevels: number[],
  gapUnit: number,
  gapLevel: number,
  skipUnit: number,
  skipLevel: number,
  correctCount: number,
  totalCount: number,
): any[] {
  const percentage = Math.round((correctCount / totalCount) * 100);
  const gapTopics = failedLevels.map((l) => `• *Level ${l}*: ${LEVEL_TOPICS[l] ?? 'general skills'}`).join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Placement complete!* You got ${correctCount}/${totalCount} correct (${percentage}%).`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `You showed strong skills on the harder questions, but it looks like you might have some gaps in the basics:\n\n${gapTopics}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Where would you like to start?',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `Fill the gaps (Unit ${gapUnit}, Level ${gapLevel})`, emoji: true },
          action_id: 'placement_fill_gaps',
          value: JSON.stringify({ unitOrder: gapUnit, level: gapLevel }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: `Skip ahead (Unit ${skipUnit}, Level ${skipLevel})`, emoji: true },
          action_id: 'placement_skip_ahead',
          value: JSON.stringify({ unitOrder: skipUnit, level: skipLevel }),
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "_Filling gaps means you'll breeze through the easy stuff fast and build a solid foundation. Skipping ahead jumps to where your strongest skills are._",
        },
      ],
    },
  ];
}

export function formatQuestionBlocks(question: PlacementQuestion, questionNum: number, totalQuestions: number): any[] {
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Question ${questionNum}/${totalQuestions}*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: question.question },
    },
    {
      type: 'actions',
      elements: question.options.map((option, idx) => ({
        type: 'button',
        text: { type: 'plain_text', text: option, emoji: true },
        action_id: `placement_answer_${idx}`,
        value: String(idx),
      })),
    },
  ];

  return blocks;
}

export function formatPlacementResultBlocks(unitOrder: number, level: number, correctCount: number, totalCount: number): any[] {
  const percentage = Math.round((correctCount / totalCount) * 100);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Placement complete!* You got ${correctCount}/${totalCount} correct (${percentage}%).`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `You'll start at *Unit ${unitOrder}* (Level ${level}). ${
          unitOrder === 1
            ? "We'll build from the ground up!"
            : `You've shown solid skills — let's pick up from here!`
        }`,
      },
    },
  ];
}

// ── Question Pool ───────────────────────────────────────────

const QUESTION_POOL: PlacementQuestion[] = [
  // ── Level 1 (6 questions) ──
  {
    id: 'L1_01', level: 1,
    question: 'How do you say "Hello, how are you?" in Argentine Spanish?',
    options: ['Hola, ¿cómo andás?', 'Adiós, ¿qué tal?', 'Buenos días, ¿cómo estás tú?', 'Hola, ¿qué hora es?'],
    correctIndex: 0,
  },
  {
    id: 'L1_02', level: 1,
    question: 'What does "Me llamo Juan" mean?',
    options: ['I called Juan', 'My name is Juan', 'I like Juan', 'Juan called me'],
    correctIndex: 1,
  },
  {
    id: 'L1_03', level: 1,
    question: 'Which is the correct way to say "I am from the United States"?',
    options: ['Estoy de Estados Unidos', 'Soy de Estados Unidos', 'Tengo de Estados Unidos', 'Voy de Estados Unidos'],
    correctIndex: 1,
  },
  {
    id: 'L1_04', level: 1,
    question: 'How do you say "the bill, please" at a restaurant?',
    options: ['La mesa, por favor', 'La cuenta, por favor', 'El menú, por favor', 'La comida, por favor'],
    correctIndex: 1,
  },
  {
    id: 'L1_05', level: 1,
    question: 'What does "¿Dónde queda la iglesia?" mean?',
    options: ['Where is the church?', 'When is the church?', 'What is the church?', 'Why is the church?'],
    correctIndex: 0,
  },
  {
    id: 'L1_06', level: 1,
    question: '"Estoy cansado" means:',
    options: ['I am married', 'I am tired', 'I am hungry', 'I am happy'],
    correctIndex: 1,
  },

  // ── Level 2 (7 questions) ──
  {
    id: 'L2_01', level: 2,
    question: 'In Argentine Spanish, "vos hablás" means the same as:',
    options: ['yo hablo', 'tú hablas', 'él habla', 'nosotros hablamos'],
    correctIndex: 1,
  },
  {
    id: 'L2_02', level: 2,
    question: 'What is the correct past tense? "Ayer yo _____ a la iglesia" (ir)',
    options: ['iba', 'fui', 'voy', 'iré'],
    correctIndex: 1,
  },
  {
    id: 'L2_03', level: 2,
    question: '"¿Cómo te sentís?" is asking about your:',
    options: ['Name', 'Age', 'Feelings', 'Location'],
    correctIndex: 2,
  },
  {
    id: 'L2_04', level: 2,
    question: 'Which sentence uses the imperfect tense correctly?',
    options: ['Ayer comí pizza', 'Cuando era chico, jugaba al fútbol', 'Mañana voy a correr', 'Hoy estoy contento'],
    correctIndex: 1,
  },
  {
    id: 'L2_05', level: 2,
    question: '"Dios te bendiga" means:',
    options: ['God bless you', 'God is great', 'God loves you', 'God is here'],
    correctIndex: 0,
  },
  {
    id: 'L2_06', level: 2,
    question: 'What is the vos form of "tener" (present tense)?',
    options: ['Tienes', 'Tenés', 'Tiene', 'Tengo'],
    correctIndex: 1,
  },
  {
    id: 'L2_07', level: 2,
    question: '"Mandame un mensaje" means:',
    options: ['Give me a gift', 'Send me a message', 'Tell me a story', 'Leave me alone'],
    correctIndex: 1,
  },

  // ── Level 3 (6 questions) ──
  {
    id: 'L3_01', level: 3,
    question: 'What does "laburo" mean in lunfardo?',
    options: ['Food', 'Money', 'Work', 'Party'],
    correctIndex: 2,
  },
  {
    id: 'L3_02', level: 3,
    question: 'Which sentence correctly uses the subjunctive?',
    options: ['Quiero que venís', 'Quiero que vengas', 'Quiero que vienes', 'Quiero que viniste'],
    correctIndex: 1,
  },
  {
    id: 'L3_03', level: 3,
    question: '"Me parece que tenés razón" expresses:',
    options: ['A command', 'An opinion', 'A question', 'A complaint'],
    correctIndex: 1,
  },
  {
    id: 'L3_04', level: 3,
    question: 'What does "pibe" mean?',
    options: ['Old man', 'Kid/guy', 'Boss', 'Friend'],
    correctIndex: 1,
  },
  {
    id: 'L3_05', level: 3,
    question: 'In Argentine mate culture, saying "gracias" when passed the mate means:',
    options: ['Thank you, give me more', 'I appreciate the mate', 'No more for me, thanks', 'It tastes great'],
    correctIndex: 2,
  },
  {
    id: 'L3_06', level: 3,
    question: '"Si pudiera, viajaría a Argentina" uses which tenses?',
    options: ['Present + Future', 'Past subjunctive + Conditional', 'Imperfect + Preterite', 'Present + Imperfect'],
    correctIndex: 1,
  },

  // ── Level 4 (6 questions) ──
  {
    id: 'L4_01', level: 4,
    question: 'What is "feca" in vesre?',
    options: ['Face', 'Café', 'Fake', 'Fence'],
    correctIndex: 1,
  },
  {
    id: 'L4_02', level: 4,
    question: '"Si hubiera sabido, habría ido" means:',
    options: ['If I knew, I would go', 'If I had known, I would have gone', 'If I know, I will go', 'When I found out, I went'],
    correctIndex: 1,
  },
  {
    id: 'L4_03', level: 4,
    question: '"Está al horno" means someone is:',
    options: ['Cooking dinner', 'In big trouble', 'Very hot', 'At the bakery'],
    correctIndex: 1,
  },
  {
    id: 'L4_04', level: 4,
    question: 'What does "hacerse el boludo" mean?',
    options: ['To get angry', 'To play dumb', 'To be brave', 'To be generous'],
    correctIndex: 1,
  },
  {
    id: 'L4_05', level: 4,
    question: '"Bardear" in lunfardo means:',
    options: ['To sing', 'To disrespect/cause trouble', 'To dance', 'To celebrate'],
    correctIndex: 1,
  },
  {
    id: 'L4_06', level: 4,
    question: 'Which is a correct use of the past subjunctive?',
    options: ['Ojalá que lloviera mañana', 'Ojalá que llueve mañana', 'Ojalá que lloverá mañana', 'Ojalá que llovió mañana'],
    correctIndex: 0,
  },
];
