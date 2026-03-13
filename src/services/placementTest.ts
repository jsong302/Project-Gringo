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
    // Pick 5 questions per level for a more reliable assessment
    const count = 5;
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
  /** Total correct answers (set when testComplete) */
  totalCorrect: number;
  /** Total questions answered (set when testComplete) */
  totalQuestions: number;
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

    const totalCorrect = state.answers.filter((a) => a.correct).length;
    const totalQuestions = state.answers.length;

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
        totalCorrect,
        totalQuestions,
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
      totalCorrect,
      totalQuestions,
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
    totalCorrect: 0,
    totalQuestions: 0,
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
    if (scores.correct / scores.total >= 0.6) {
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
  // ── Level 1: Greetings, numbers, ser/estar, basic present tense (12 questions) ──
  {
    id: 'L1_01', level: 1,
    question: 'How do you say "Hello, how are you?" in Argentine Spanish?',
    options: ['Hola, ¿cómo andás?', 'Hola, ¿cómo estás tú?', 'Hola, ¿qué hora es?'],
    correctIndex: 0,
  },
  {
    id: 'L1_02', level: 1,
    question: '"Soy de Estados Unidos" — which verb is "soy" a form of?',
    options: ['estar', 'ser', 'ir', 'saber'],
    correctIndex: 1,
  },
  {
    id: 'L1_03', level: 1,
    question: 'Which sentence correctly uses "estar"?',
    options: ['Estoy profesor', 'Estoy contento', 'Estoy de Argentina', 'Estoy Juan'],
    correctIndex: 1,
  },
  {
    id: 'L1_04', level: 1,
    question: 'How do you say "15" in Spanish?',
    options: ['Cincuenta', 'Quince', 'Cinco', 'Catorce'],
    correctIndex: 1,
  },
  {
    id: 'L1_05', level: 1,
    question: '"Ella habla español" means:',
    options: ['She speaks Spanish', 'She spoke Spanish', 'She will speak Spanish', 'She is Spanish'],
    correctIndex: 0,
  },
  {
    id: 'L1_06', level: 1,
    question: 'Complete: "Nosotros _____ estudiantes" (We are students)',
    options: ['estamos', 'somos', 'tenemos', 'vamos'],
    correctIndex: 1,
  },
  {
    id: 'L1_07', level: 1,
    question: '"¿Cuánto cuesta?" means:',
    options: ['What time is it?', 'How much does it cost?', 'Where is it?', 'Who is it?'],
    correctIndex: 1,
  },
  {
    id: 'L1_08', level: 1,
    question: 'Which word means "but"?',
    options: ['porque', 'pero', 'para', 'por'],
    correctIndex: 1,
  },
  {
    id: 'L1_09', level: 1,
    question: '"La iglesia está cerca" — "cerca" means:',
    options: ['closed', 'far', 'nearby', 'open'],
    correctIndex: 2,
  },
  {
    id: 'L1_10', level: 1,
    question: 'Complete: "Yo _____ agua" (I drink water)',
    options: ['como', 'bebo', 'leo', 'abro'],
    correctIndex: 1,
  },
  {
    id: 'L1_11', level: 1,
    question: 'What does "No entiendo" mean?',
    options: ['I don\'t know', 'I don\'t understand', 'I don\'t want', 'I don\'t have'],
    correctIndex: 1,
  },
  {
    id: 'L1_12', level: 1,
    question: '"Mi hermano tiene veinte años" — what does "tiene" mean here?',
    options: ['has (age)', 'is', 'wants', 'holds'],
    correctIndex: 0,
  },

  // ── Level 2: Past tense, voseo basics, daily vocabulary (12 questions) ──
  {
    id: 'L2_01', level: 2,
    question: 'What is the vos form of "hablar" in present tense?',
    options: ['hablás', 'hablas', 'hablés', 'habláis'],
    correctIndex: 0,
  },
  {
    id: 'L2_02', level: 2,
    question: '"Ayer fui a la iglesia" — which tense is "fui"?',
    options: ['Present', 'Imperfect', 'Preterite', 'Future'],
    correctIndex: 2,
  },
  {
    id: 'L2_03', level: 2,
    question: 'Which sentence uses the imperfect tense correctly?',
    options: ['Ayer comí pizza', 'De chico, siempre jugaba al fútbol', 'Mañana voy a correr', 'Hoy comí mucho'],
    correctIndex: 1,
  },
  {
    id: 'L2_04', level: 2,
    question: 'The vos imperative of "venir" is:',
    options: ['ven', 'vení', 'venís', 'viene'],
    correctIndex: 1,
  },
  {
    id: 'L2_05', level: 2,
    question: '"Ella se levantó temprano" means:',
    options: ['She went to bed early', 'She got up early', 'She left early', 'She arrived early'],
    correctIndex: 1,
  },
  {
    id: 'L2_06', level: 2,
    question: 'Complete: "Cuando era chico, _____ mucho" (used to read a lot)',
    options: ['leí', 'leía', 'leo', 'leeré'],
    correctIndex: 1,
  },
  {
    id: 'L2_07', level: 2,
    question: 'What is the vos form of "poder" (present)?',
    options: ['puedes', 'podés', 'puede', 'podéis'],
    correctIndex: 1,
  },
  {
    id: 'L2_08', level: 2,
    question: '"¿Ya comiste?" — what is being asked?',
    options: ['Are you cooking?', 'Did you eat already?', 'Do you want to eat?', 'What did you cook?'],
    correctIndex: 1,
  },
  {
    id: 'L2_09', level: 2,
    question: 'Which is the correct preterite? "Ellos _____ a Buenos Aires" (ir)',
    options: ['iban', 'fueron', 'van', 'irán'],
    correctIndex: 1,
  },
  {
    id: 'L2_10', level: 2,
    question: '"Contame qué pasó" — "contame" uses which form?',
    options: ['tú imperative', 'vos imperative', 'usted imperative', 'subjunctive'],
    correctIndex: 1,
  },
  {
    id: 'L2_11', level: 2,
    question: 'Preterite vs imperfect: "_____ las 8 cuando _____ a llover"',
    options: ['Fueron / empezó', 'Eran / empezó', 'Fueron / empezaba', 'Son / empezó'],
    correctIndex: 1,
  },
  {
    id: 'L2_12', level: 2,
    question: '"Le pedí plata prestada" means:',
    options: ['I lent him money', 'I asked him to borrow money', 'I paid him money', 'I found his money'],
    correctIndex: 1,
  },

  // ── Level 3: Subjunctive, lunfardo, opinions, indirect speech (12 questions) ──
  {
    id: 'L3_01', level: 3,
    question: 'Which correctly uses the subjunctive?',
    options: ['Quiero que vengas', 'Quiero que venís', 'Quiero que vienes', 'Quiero que vas a venir'],
    correctIndex: 0,
  },
  {
    id: 'L3_02', level: 3,
    question: '"Laburo" in lunfardo means:',
    options: ['sleep', 'food', 'work', 'money'],
    correctIndex: 2,
  },
  {
    id: 'L3_03', level: 3,
    question: 'Complete: "Ojalá que _____ buen tiempo mañana" (I hope the weather is nice)',
    options: ['hace', 'haga', 'hiciera', 'haría'],
    correctIndex: 1,
  },
  {
    id: 'L3_04', level: 3,
    question: '"No creo que sea cierto" — why is "sea" subjunctive here?',
    options: ['It follows a negated belief/opinion', 'It\'s a question', 'It\'s past tense', 'It\'s a command'],
    correctIndex: 0,
  },
  {
    id: 'L3_05', level: 3,
    question: '"Me copa esa idea" means:',
    options: ['I hate that idea', 'That idea confuses me', 'I\'m really into that idea', 'That idea is mine'],
    correctIndex: 2,
  },
  {
    id: 'L3_06', level: 3,
    question: 'In Argentine mate culture, saying "gracias" when passed the mate means:',
    options: ['Pour me more', 'I appreciate the flavor', 'No more for me', 'It needs more sugar'],
    correctIndex: 2,
  },
  {
    id: 'L3_07', level: 3,
    question: 'Complete: "Es importante que todos _____ a tiempo" (arrive)',
    options: ['llegan', 'lleguen', 'llegaron', 'llegarán'],
    correctIndex: 1,
  },
  {
    id: 'L3_08', level: 3,
    question: '"Afanar" in lunfardo means:',
    options: ['to work hard', 'to steal', 'to run', 'to eat'],
    correctIndex: 1,
  },
  {
    id: 'L3_09', level: 3,
    question: '"Me dijo que vendría" uses:',
    options: ['Present + Future', 'Preterite + Conditional', 'Imperfect + Subjunctive', 'Present + Subjunctive'],
    correctIndex: 1,
  },
  {
    id: 'L3_10', level: 3,
    question: '"Estoy al pedo" means:',
    options: ['I\'m angry', 'I\'m busy', 'I\'m doing nothing / bored', 'I\'m drunk'],
    correctIndex: 2,
  },
  {
    id: 'L3_11', level: 3,
    question: 'Complete: "Dudo que él _____ la verdad" (saber)',
    options: ['sabe', 'sepa', 'sabía', 'supiera'],
    correctIndex: 1,
  },
  {
    id: 'L3_12', level: 3,
    question: '"Morfi" in lunfardo means:',
    options: ['death', 'food', 'sleep', 'party'],
    correctIndex: 1,
  },

  // ── Level 4: Complex grammar, vesre, idioms, advanced lunfardo (12 questions) ──
  {
    id: 'L4_01', level: 4,
    question: '"Feca" in vesre is:',
    options: ['face', 'café', 'fake', 'faith'],
    correctIndex: 1,
  },
  {
    id: 'L4_02', level: 4,
    question: '"Si hubiera sabido, habría ido" means:',
    options: ['If I knew, I would go', 'If I had known, I would have gone', 'When I found out, I went', 'If I know, I\'ll go'],
    correctIndex: 1,
  },
  {
    id: 'L4_03', level: 4,
    question: '"Está al horno" means:',
    options: ['He\'s cooking', 'He\'s in big trouble', 'He\'s very hot', 'He\'s at the bakery'],
    correctIndex: 1,
  },
  {
    id: 'L4_04', level: 4,
    question: '"Hacerse el boludo" means:',
    options: ['To get angry', 'To play dumb/pretend not to notice', 'To be brave', 'To act crazy'],
    correctIndex: 1,
  },
  {
    id: 'L4_05', level: 4,
    question: 'Complete: "Si _____ más tiempo, habría terminado el proyecto"',
    options: ['tenía', 'tuve', 'hubiera tenido', 'tendría'],
    correctIndex: 2,
  },
  {
    id: 'L4_06', level: 4,
    question: '"Garpa" in lunfardo means:',
    options: ['It\'s expensive', 'It\'s worth it / pays off', 'It\'s broken', 'It\'s ugly'],
    correctIndex: 1,
  },
  {
    id: 'L4_07', level: 4,
    question: '"Jermu" in vesre is:',
    options: ['hermano', 'mujer', 'mejor', 'germán'],
    correctIndex: 1,
  },
  {
    id: 'L4_08', level: 4,
    question: 'Which uses the pluperfect subjunctive correctly?',
    options: [
      'Si hubiéramos llegado antes, habríamos conseguido lugar',
      'Si llegaramos antes, consiguiéramos lugar',
      'Si habíamos llegado antes, conseguimos lugar',
      'Si llegamos antes, habríamos conseguido lugar',
    ],
    correctIndex: 0,
  },
  {
    id: 'L4_09', level: 4,
    question: '"Flashear" means:',
    options: ['To take a photo', 'To imagine/hallucinate/be delusional', 'To run fast', 'To get angry'],
    correctIndex: 1,
  },
  {
    id: 'L4_10', level: 4,
    question: '"Le re cabió" means:',
    options: ['He really liked it', 'He really deserved it / got what was coming', 'He really understood', 'He really tried hard'],
    correctIndex: 1,
  },
  {
    id: 'L4_11', level: 4,
    question: 'Complete: "No habría pasado si vos no _____ eso"',
    options: ['dijiste', 'decías', 'hubieras dicho', 'dirías'],
    correctIndex: 2,
  },
  {
    id: 'L4_12', level: 4,
    question: '"Rescatate" in Argentine slang means:',
    options: ['Save yourself', 'Calm down / get a grip', 'Run away', 'Help me'],
    correctIndex: 1,
  },
];
