/**
 * Exit Exam Bank — generates question banks for exit exams via LLM.
 *
 * Each level gets ~80-100 questions generated from unit content.
 * Questions are stored in the DB and randomly sampled for each exam attempt.
 */
import { log } from '../utils/logger';
import { callLlm } from './llm';
import { getCurriculum, type CurriculumUnit } from './curriculum';
import { insertQuestion, getQuestionCountForLevel, clearQuestionsForLevel } from './exitExam';

const bankLog = log.withScope('exit-exam-bank');

// In-memory lock to prevent concurrent generation
let generating = false;

export function isExamBankGenerating(): boolean {
  return generating;
}

/**
 * Generate questions for a single unit.
 * Returns the number of questions successfully inserted.
 */
export async function generateQuestionsForUnit(unit: CurriculumUnit, count: number = 10): Promise<number> {
  const prompt = `You are creating test questions for a Level ${unit.levelBand} Argentine Spanish exit exam.
These questions test material from: "${unit.title}" (${unit.topic}).
${unit.description ? `Unit description: ${unit.description}` : ''}
${unit.lessonPrompt ? `Teaching focus: ${unit.lessonPrompt.slice(0, 500)}` : ''}

Generate exactly ${count} questions as a JSON array. Mix question types:
- ~50% "mc" (multiple choice with 4 options)
- ~25% "fill_blank" (fill in the blank)
- ~25% "translation" (translate a sentence)

Use this exact JSON format (no text outside the array):
[
  {
    "type": "mc",
    "question": "What does 'hola' mean?",
    "options": ["Hello", "Goodbye", "Thanks", "Please"],
    "correctIndex": 0
  },
  {
    "type": "fill_blank",
    "question": "Complete: Yo _____ al mercado (ir, present tense)",
    "answers": ["voy"]
  },
  {
    "type": "translation",
    "question": "Translate to Spanish: 'I went to church yesterday'",
    "direction": "en_to_es",
    "referenceAnswer": "Ayer fui a la iglesia"
  }
]

Rules:
- Use Argentine Spanish (voseo: vos hablás, vos tenés, vos sos)
- For fill_blank "answers", include ALL acceptable variations (e.g., ["voy", "yo voy"])
- For translation, alternate between en_to_es and es_to_en
- Keep questions clear and unambiguous
- Test practical, conversational usage — not obscure grammar trivia
- Students type on English keyboards — accept answers without accents/tildes
- For fill_blank answers, include both accented and unaccented forms (e.g., ["estás", "estas", "vos estás", "vos estas"])
- MC options should be plausible (not obviously wrong)
- Vary difficulty within the level`;

  try {
    const response = await callLlm({
      system: prompt,
      messages: [{ role: 'user', content: 'Generate the questions now.' }],
      temperature: 0.8,
      maxTokens: 4000,
    });

    const cleaned = response.text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const questions = JSON.parse(cleaned);

    if (!Array.isArray(questions)) {
      bankLog.error(`Expected array for unit ${unit.id}, got ${typeof questions}`);
      return 0;
    }

    let inserted = 0;
    for (const q of questions) {
      try {
        switch (q.type) {
          case 'mc':
            if (!q.question || !Array.isArray(q.options) || q.correctIndex === undefined) continue;
            insertQuestion(
              unit.levelBand, unit.id, 'mc',
              q.question, q.options, q.correctIndex,
              null, null, null,
            );
            inserted++;
            break;

          case 'fill_blank':
            if (!q.question || !Array.isArray(q.answers)) continue;
            insertQuestion(
              unit.levelBand, unit.id, 'fill_blank',
              q.question, null, null,
              q.answers, null, null,
            );
            inserted++;
            break;

          case 'translation':
            if (!q.question || !q.referenceAnswer) continue;
            insertQuestion(
              unit.levelBand, unit.id, 'translation',
              q.question, null, null,
              null, q.direction || 'en_to_es', q.referenceAnswer,
            );
            inserted++;
            break;
        }
      } catch (err) {
        bankLog.warn(`Failed to insert question for unit ${unit.id}: ${err}`);
      }
    }

    bankLog.info(`Generated ${inserted} questions for unit ${unit.id} (${unit.title})`);
    return inserted;
  } catch (err) {
    bankLog.error(`Question generation failed for unit ${unit.id}: ${err}`);
    return 0;
  }
}

/**
 * Generate a full question bank for a level.
 * Generates ~10 questions per unit in the level.
 */
export async function generateBankForLevel(
  levelBand: number,
  force = false,
): Promise<{ generated: number; errors: number }> {
  const units = getCurriculum().filter(u => u.levelBand === levelBand);
  if (units.length === 0) {
    return { generated: 0, errors: 0 };
  }

  const existing = getQuestionCountForLevel(levelBand);
  if (!force && existing >= 50) {
    bankLog.info(`Level ${levelBand} already has ${existing} questions — skipping (use force to regenerate)`);
    return { generated: 0, errors: 0 };
  }

  if (force && existing > 0) {
    clearQuestionsForLevel(levelBand);
    bankLog.info(`Cleared ${existing} existing questions for level ${levelBand}`);
  }

  let totalGenerated = 0;
  let totalErrors = 0;

  for (const unit of units) {
    const count = await generateQuestionsForUnit(unit, 10);
    if (count > 0) {
      totalGenerated += count;
    } else {
      totalErrors++;
    }
  }

  bankLog.info(`Level ${levelBand} bank: ${totalGenerated} questions from ${units.length} units (${totalErrors} errors)`);
  return { generated: totalGenerated, errors: totalErrors };
}

/**
 * Generate question banks for all levels (1-4).
 * Only one run at a time.
 */
export async function generateAllExamBanks(
  force = false,
): Promise<{ generated: number; errors: number }> {
  if (generating) {
    return { generated: 0, errors: 0 };
  }

  generating = true;
  try {
    let totalGenerated = 0;
    let totalErrors = 0;

    for (let level = 1; level <= 4; level++) {
      const result = await generateBankForLevel(level, force);
      totalGenerated += result.generated;
      totalErrors += result.errors;
    }

    bankLog.info(`All exam banks: ${totalGenerated} questions total (${totalErrors} errors)`);
    return { generated: totalGenerated, errors: totalErrors };
  } finally {
    generating = false;
  }
}
