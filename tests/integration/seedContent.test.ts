import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import {
  seedAllContent,
  seedVocabulary,
  seedConjugations,
  seedPhrases,
  seedVesre,
  VOCABULARY,
  CONJUGATIONS,
  PHRASES,
  VESRE,
} from '../../src/services/seedContent';

const TEST_DB_PATH = './data/test-seed-content.db';

describe('Seed Content', () => {
  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    await initDb({ path: TEST_DB_PATH });
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should have reasonable amount of seed data defined', () => {
    expect(VOCABULARY.length).toBeGreaterThanOrEqual(20);
    expect(CONJUGATIONS.length).toBeGreaterThanOrEqual(15);
    expect(PHRASES.length).toBeGreaterThanOrEqual(15);
    expect(VESRE.length).toBeGreaterThanOrEqual(10);
  });

  it('should seed vocabulary', () => {
    const inserted = seedVocabulary();
    expect(inserted).toBe(VOCABULARY.length);

    const db = getDb();
    const result = db.exec('SELECT COUNT(*) FROM vocabulary');
    expect(result[0].values[0][0]).toBe(VOCABULARY.length);
  });

  it('should seed conjugations', () => {
    const inserted = seedConjugations();
    expect(inserted).toBe(CONJUGATIONS.length);

    const db = getDb();
    const result = db.exec('SELECT COUNT(*) FROM conjugations');
    expect(result[0].values[0][0]).toBe(CONJUGATIONS.length);
  });

  it('should seed phrases', () => {
    const inserted = seedPhrases();
    expect(inserted).toBe(PHRASES.length);

    const db = getDb();
    const result = db.exec('SELECT COUNT(*) FROM phrases');
    expect(result[0].values[0][0]).toBe(PHRASES.length);
  });

  it('should seed vesre', () => {
    const inserted = seedVesre();
    expect(inserted).toBe(VESRE.length);

    const db = getDb();
    const result = db.exec('SELECT COUNT(*) FROM vesre');
    expect(result[0].values[0][0]).toBe(VESRE.length);
  });

  it('should be idempotent — second seed inserts nothing', () => {
    // Everything is already seeded from above tests
    const v = seedVocabulary();
    const c = seedConjugations();
    const p = seedPhrases();
    const ve = seedVesre();

    expect(v).toBe(0);
    expect(c).toBe(0);
    expect(p).toBe(0);
    expect(ve).toBe(0);
  });

  it('should have vocab entries with all difficulty levels 1-3', () => {
    const difficulties = new Set(VOCABULARY.map((v) => v.difficulty));
    expect(difficulties.has(1)).toBe(true);
    expect(difficulties.has(2)).toBe(true);
    expect(difficulties.has(3)).toBe(true);
  });

  it('should have lunfardo entries', () => {
    const lunfardoCount = VOCABULARY.filter((v) => v.isLunfardo).length;
    expect(lunfardoCount).toBeGreaterThan(10);
  });

  it('should handle special characters in content', () => {
    // Phrases contain accented chars, question marks, etc.
    const db = getDb();
    const result = db.exec(`SELECT spanish FROM phrases WHERE spanish LIKE '%¿%'`);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values.length).toBeGreaterThan(0);
  });
});
