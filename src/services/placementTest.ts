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
    const { unitOrder, level } = calculatePlacement(state);

    // Save to DB
    savePlacementResult(state, unitOrder, level);

    // Initialize curriculum progress
    initializeUserProgress(state.userId, unitOrder);

    ptLog.info(`Placement complete for ${slackUserId}: unit ${unitOrder}, level ${level}`);
    activeTests.delete(slackUserId);

    return {
      correct,
      nextQuestion: null,
      testComplete: true,
      placedAtUnit: unitOrder,
      derivedLevel: level,
    };
  }

  return {
    correct,
    nextQuestion: state.questionPool[state.currentQuestionIndex],
    testComplete: false,
    placedAtUnit: 0,
    derivedLevel: 0,
  };
}

// ── Placement calculation ───────────────────────────────────

function calculatePlacement(state: PlacementState): { unitOrder: number; level: number } {
  // Group answers by level and calculate pass rate per level
  const levelScores = new Map<number, { correct: number; total: number }>();

  for (const answer of state.answers) {
    const level = answer.question.level;
    const existing = levelScores.get(level) ?? { correct: 0, total: 0 };
    existing.total++;
    if (answer.correct) existing.correct++;
    levelScores.set(level, existing);
  }

  // Find the highest level where they passed most questions (>= 50%)
  let highestPassedLevel = 0;
  for (let level = 1; level <= 4; level++) {
    const scores = levelScores.get(level);
    if (!scores) continue;
    if (scores.correct / scores.total >= 0.5) {
      highestPassedLevel = level;
    } else {
      break; // Stop at first failed level
    }
  }

  // Map to curriculum unit
  const curriculum = getCurriculum();
  if (curriculum.length === 0) {
    return { unitOrder: 1, level: 1 };
  }

  if (highestPassedLevel === 0) {
    // Failed level 1 — start from the very beginning
    return { unitOrder: 1, level: 1 };
  }

  // Place at the first unit of the NEXT level (they demonstrated this level)
  const nextLevel = Math.min(highestPassedLevel + 1, 4);
  const targetUnit = getFirstUnitForLevel(nextLevel);
  if (targetUnit) {
    return { unitOrder: targetUnit.unitOrder, level: targetUnit.levelBand };
  }

  // Fallback: place at last unit of the passed level
  const lastPassedUnit = curriculum
    .filter((u) => u.levelBand === highestPassedLevel)
    .pop();
  if (lastPassedUnit) {
    return { unitOrder: lastPassedUnit.unitOrder, level: lastPassedUnit.levelBand };
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

// ── Slack formatting ────────────────────────────────────────

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
