/**
 * Card Content Resolver
 *
 * Given an SRS card (type + content_id), fetches the actual
 * content from the appropriate table and formats it for display.
 */
import { getDb } from '../db';
import type { CardType, SrsCard } from './srsRepository';

// ── Types ───────────────────────────────────────────────────

export interface CardContent {
  front: string;       // What the user sees (the question)
  back: string;        // The answer
  hint?: string;       // Optional hint
  category?: string;
  difficulty?: number;
  metadata?: Record<string, string>;
}

// ── Resolvers ───────────────────────────────────────────────

export function getCardContent(card: SrsCard): CardContent | null {
  switch (card.cardType) {
    case 'vocab':       return getVocabContent(card.contentId);
    case 'conjugation': return getConjugationContent(card.contentId);
    case 'phrase':      return getPhraseContent(card.contentId);
    case 'vesre':       return getVesreContent(card.contentId);
    default:            return null;
  }
}

function getVocabContent(contentId: number): CardContent | null {
  const db = getDb();
  const result = db.exec(
    `SELECT spanish, english, category, difficulty, example_sentence, is_lunfardo, pronunciation_notes
     FROM vocabulary WHERE id = ${contentId}`,
  );
  if (!result.length || !result[0].values.length) return null;
  const [spanish, english, category, difficulty, example, isLunfardo, pronunciation] = result[0].values[0];

  return {
    front: `¿Qué significa "${spanish}"?`,
    back: english as string,
    hint: example ? `Ejemplo: ${example}` : undefined,
    category: category as string,
    difficulty: difficulty as number,
    metadata: {
      spanish: spanish as string,
      english: english as string,
      ...(isLunfardo ? { lunfardo: 'sí' } : {}),
      ...(pronunciation ? { pronunciation: pronunciation as string } : {}),
    },
  };
}

function getConjugationContent(contentId: number): CardContent | null {
  const db = getDb();
  const result = db.exec(
    `SELECT verb_infinitive, tense, mood, vos_form, tu_form, example_sentence
     FROM conjugations WHERE id = ${contentId}`,
  );
  if (!result.length || !result[0].values.length) return null;
  const [verb, tense, mood, vosForm, tuForm, example] = result[0].values[0];

  return {
    front: `Conjugá "${verb}" en ${tense} (${mood}) con vos`,
    back: vosForm as string,
    hint: tuForm ? `Con tú: ${tuForm}` : undefined,
    category: 'conjugation',
    metadata: {
      verb: verb as string,
      tense: tense as string,
      mood: mood as string,
      vosForm: vosForm as string,
      ...(tuForm ? { tuForm: tuForm as string } : {}),
      ...(example ? { example: example as string } : {}),
    },
  };
}

function getPhraseContent(contentId: number): CardContent | null {
  const db = getDb();
  const result = db.exec(
    `SELECT spanish, english, category, difficulty, context_notes
     FROM phrases WHERE id = ${contentId}`,
  );
  if (!result.length || !result[0].values.length) return null;
  const [spanish, english, category, difficulty, context] = result[0].values[0];

  return {
    front: `¿Cómo se dice en argentino: "${english}"?`,
    back: spanish as string,
    hint: context ? context as string : undefined,
    category: category as string,
    difficulty: difficulty as number,
    metadata: {
      spanish: spanish as string,
      english: english as string,
    },
  };
}

function getVesreContent(contentId: number): CardContent | null {
  const db = getDb();
  const result = db.exec(
    `SELECT original, vesre_form, meaning, example_sentence
     FROM vesre WHERE id = ${contentId}`,
  );
  if (!result.length || !result[0].values.length) return null;
  const [original, vesreForm, meaning, example] = result[0].values[0];

  return {
    front: `¿Cuál es la forma vesre de "${original}"?`,
    back: vesreForm as string,
    hint: meaning ? `Significado: ${meaning}` : undefined,
    category: 'vesre',
    metadata: {
      original: original as string,
      vesreForm: vesreForm as string,
      ...(meaning ? { meaning: meaning as string } : {}),
      ...(example ? { example: example as string } : {}),
    },
  };
}
