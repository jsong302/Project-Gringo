import { describe, it, expect } from 'vitest';
import {
  calculateEaseFactor,
  calculateInterval,
  sm2,
  isDue,
  qualityFromLabel,
  MIN_EASE_FACTOR,
  DEFAULT_EASE_FACTOR,
  FIRST_INTERVAL,
  SECOND_INTERVAL,
} from '../../src/services/srs';

describe('calculateEaseFactor', () => {
  it('should increase EF for perfect quality (5)', () => {
    const ef = calculateEaseFactor(2.5, 5);
    expect(ef).toBeCloseTo(2.6, 1);
  });

  it('should keep EF roughly the same for quality 4', () => {
    const ef = calculateEaseFactor(2.5, 4);
    expect(ef).toBeCloseTo(2.5, 1);
  });

  it('should decrease EF for quality 3', () => {
    const ef = calculateEaseFactor(2.5, 3);
    expect(ef).toBeLessThan(2.5);
  });

  it('should decrease EF significantly for quality 0', () => {
    const ef = calculateEaseFactor(2.5, 0);
    expect(ef).toBeLessThan(2.0);
  });

  it('should never go below MIN_EASE_FACTOR', () => {
    // Repeatedly low quality should floor at 1.3
    let ef = 1.4;
    for (let i = 0; i < 10; i++) {
      ef = calculateEaseFactor(ef, 0);
    }
    expect(ef).toBe(MIN_EASE_FACTOR);
  });

  it('should clamp to MIN_EASE_FACTOR when calculated value is below', () => {
    const ef = calculateEaseFactor(MIN_EASE_FACTOR, 0);
    expect(ef).toBe(MIN_EASE_FACTOR);
  });
});

describe('calculateInterval', () => {
  it('should return 1 day for first correct review', () => {
    expect(calculateInterval(0, 0, 2.5, 4)).toBe(FIRST_INTERVAL);
  });

  it('should return 6 days for second correct review', () => {
    expect(calculateInterval(1, 1, 2.5, 4)).toBe(SECOND_INTERVAL);
  });

  it('should multiply by ease factor for third+ correct review', () => {
    const interval = calculateInterval(6, 2, 2.5, 4);
    expect(interval).toBe(15); // 6 * 2.5 = 15
  });

  it('should reset to 1 day for incorrect answer (quality < 3)', () => {
    expect(calculateInterval(15, 5, 2.5, 2)).toBe(FIRST_INTERVAL);
    expect(calculateInterval(15, 5, 2.5, 0)).toBe(FIRST_INTERVAL);
  });

  it('should handle large intervals', () => {
    const interval = calculateInterval(30, 5, 2.5, 5);
    expect(interval).toBe(75); // 30 * 2.5
  });
});

describe('sm2', () => {
  const freshCard = {
    easeFactor: DEFAULT_EASE_FACTOR,
    interval: 0,
    repetitions: 0,
  };

  const now = new Date('2025-06-15T10:00:00Z');

  it('should throw for quality < 0', () => {
    expect(() => sm2(freshCard, -1)).toThrow('SM-2 quality must be 0-5');
  });

  it('should throw for quality > 5', () => {
    expect(() => sm2(freshCard, 6)).toThrow('SM-2 quality must be 0-5');
  });

  it('should set interval to 1 day on first correct review', () => {
    const result = sm2(freshCard, 4, now);
    expect(result.interval).toBe(FIRST_INTERVAL);
    expect(result.repetitions).toBe(1);
    expect(result.nextReviewAt).toBe('2025-06-16 10:00:00');
  });

  it('should set interval to 6 days on second correct review', () => {
    const card = { easeFactor: 2.5, interval: 1, repetitions: 1 };
    const result = sm2(card, 4, now);
    expect(result.interval).toBe(SECOND_INTERVAL);
    expect(result.repetitions).toBe(2);
    expect(result.nextReviewAt).toBe('2025-06-21 10:00:00');
  });

  it('should multiply interval on third correct review', () => {
    const card = { easeFactor: 2.5, interval: 6, repetitions: 2 };
    const result = sm2(card, 4, now);
    expect(result.interval).toBe(15);
    expect(result.repetitions).toBe(3);
  });

  it('should reset on incorrect answer', () => {
    const card = { easeFactor: 2.5, interval: 15, repetitions: 4 };
    const result = sm2(card, 1, now);
    expect(result.interval).toBe(FIRST_INTERVAL);
    expect(result.repetitions).toBe(0);
    expect(result.nextReviewAt).toBe('2025-06-16 10:00:00');
  });

  it('should update ease factor on review', () => {
    const result = sm2(freshCard, 5, now);
    expect(result.easeFactor).toBeGreaterThan(DEFAULT_EASE_FACTOR);
  });

  it('should decrease ease factor on poor quality', () => {
    const result = sm2(freshCard, 3, now);
    expect(result.easeFactor).toBeLessThan(DEFAULT_EASE_FACTOR);
  });

  it('should produce valid ISO-like datetime string', () => {
    const result = sm2(freshCard, 4, now);
    expect(result.nextReviewAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('isDue', () => {
  it('should return true when review time has passed', () => {
    expect(isDue('2025-06-10 10:00:00', new Date('2025-06-15T12:00:00Z'))).toBe(true);
  });

  it('should return false when review time is in the future', () => {
    expect(isDue('2025-06-20 10:00:00', new Date('2025-06-15T12:00:00Z'))).toBe(false);
  });

  it('should return true when review time is in the past by 1 second', () => {
    expect(isDue('2025-06-15 11:59:59', new Date('2025-06-15T12:00:00Z'))).toBe(true);
  });
});

describe('qualityFromLabel', () => {
  it('should map again to 1', () => {
    expect(qualityFromLabel('again')).toBe(1);
  });

  it('should map hard to 3', () => {
    expect(qualityFromLabel('hard')).toBe(3);
  });

  it('should map good to 4', () => {
    expect(qualityFromLabel('good')).toBe(4);
  });

  it('should map easy to 5', () => {
    expect(qualityFromLabel('easy')).toBe(5);
  });
});
