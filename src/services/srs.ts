/**
 * SM-2 Spaced Repetition Algorithm
 *
 * Pure functions — no DB, no side effects.
 * Based on the SuperMemo SM-2 algorithm by Piotr Wozniak.
 *
 * Quality scale:
 *   0 — Complete blackout, no recall
 *   1 — Incorrect, but upon seeing the answer, remembered
 *   2 — Incorrect, but the answer seemed easy to recall
 *   3 — Correct with serious difficulty
 *   4 — Correct with some hesitation
 *   5 — Perfect recall
 */

// ── Types ───────────────────────────────────────────────────

export interface Sm2Card {
  easeFactor: number;   // >= 1.3
  interval: number;     // days (can be fractional for sub-day intervals)
  repetitions: number;  // consecutive correct responses
}

export interface Sm2Result extends Sm2Card {
  nextReviewAt: string; // ISO 8601 datetime
}

// ── Constants (defaults, overridable via system_settings) ────

export const MIN_EASE_FACTOR = 1.3;
export const DEFAULT_EASE_FACTOR = 2.5;
export const FIRST_INTERVAL = 1;   // 1 day
export const SECOND_INTERVAL = 6;  // 6 days

function getActiveSrsConstants() {
  try {
    const { getSetting } = require('./settings');
    return {
      minEF: getSetting('srs.min_ease_factor', MIN_EASE_FACTOR) as number,
      defaultEF: getSetting('srs.default_ease_factor', DEFAULT_EASE_FACTOR) as number,
      firstInterval: getSetting('srs.first_interval_days', FIRST_INTERVAL) as number,
      secondInterval: getSetting('srs.second_interval_days', SECOND_INTERVAL) as number,
    };
  } catch {
    return {
      minEF: MIN_EASE_FACTOR,
      defaultEF: DEFAULT_EASE_FACTOR,
      firstInterval: FIRST_INTERVAL,
      secondInterval: SECOND_INTERVAL,
    };
  }
}

// ── SM-2 Core ───────────────────────────────────────────────

/**
 * Calculate the new ease factor after a review.
 * EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
 * Clamped to >= 1.3
 */
export function calculateEaseFactor(
  currentEF: number,
  quality: number,
): number {
  const { minEF } = getActiveSrsConstants();
  const ef = currentEF + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  return Math.max(minEF, ef);
}

/**
 * Calculate the next interval in days.
 *
 * If quality < 3 (incorrect): reset to day 1
 * If quality >= 3 (correct):
 *   rep 1 → 1 day
 *   rep 2 → 6 days
 *   rep 3+ → previous interval * ease factor
 */
export function calculateInterval(
  currentInterval: number,
  repetitions: number,
  easeFactor: number,
  quality: number,
): number {
  const { firstInterval, secondInterval } = getActiveSrsConstants();

  if (quality < 3) {
    return firstInterval;
  }

  if (repetitions === 0) return firstInterval;
  if (repetitions === 1) return secondInterval;

  return Math.round(currentInterval * easeFactor * 10) / 10;
}

/**
 * Run the full SM-2 update for a card after a review.
 */
export function sm2(
  card: Sm2Card,
  quality: number,
  now?: Date,
): Sm2Result {
  if (quality < 0 || quality > 5) {
    throw new Error(`SM-2 quality must be 0-5, got ${quality}`);
  }

  const isCorrect = quality >= 3;

  const newEaseFactor = calculateEaseFactor(card.easeFactor, quality);

  const newRepetitions = isCorrect ? card.repetitions + 1 : 0;

  const newInterval = calculateInterval(
    card.interval,
    isCorrect ? card.repetitions : 0,
    newEaseFactor,
    quality,
  );

  const reviewDate = now ?? new Date();
  const nextReview = new Date(reviewDate);
  nextReview.setDate(nextReview.getDate() + Math.floor(newInterval));
  nextReview.setHours(
    nextReview.getHours() + Math.round((newInterval % 1) * 24),
  );

  return {
    easeFactor: newEaseFactor,
    interval: newInterval,
    repetitions: newRepetitions,
    nextReviewAt: nextReview.toISOString().replace('T', ' ').slice(0, 19),
  };
}

/**
 * Check if a card is due for review.
 */
export function isDue(nextReviewAt: string, now?: Date): boolean {
  // DB stores UTC datetimes as 'YYYY-MM-DD HH:MM:SS' — ensure parsed as UTC
  const normalized = nextReviewAt.replace(' ', 'T') + (nextReviewAt.includes('Z') ? '' : 'Z');
  const reviewDate = new Date(normalized);
  const currentDate = now ?? new Date();
  return currentDate >= reviewDate;
}

/**
 * Map a descriptive quality label to a numeric SM-2 quality.
 */
export type QualityLabel = 'again' | 'hard' | 'good' | 'easy';

export function qualityFromLabel(label: QualityLabel): number {
  switch (label) {
    case 'again': return 1;
    case 'hard':  return 3;
    case 'good':  return 4;
    case 'easy':  return 5;
  }
}
