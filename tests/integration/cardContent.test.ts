import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { createCard, getCardById } from '../../src/services/srsRepository';
import { getCardContent } from '../../src/services/cardContent';

const TEST_DB_PATH = './data/test-card-content.db';

describe('Card Content Resolver', () => {
  let userId: number;

  beforeAll(async () => {
    const fs = await import('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    // Create user
    db.run(`INSERT INTO users (slack_user_id, display_name) VALUES ('U_CONTENT', 'Content User')`);
    const result = db.exec(`SELECT id FROM users WHERE slack_user_id = 'U_CONTENT'`);
    userId = result[0].values[0][0] as number;

    // Seed vocab
    db.run(`INSERT INTO vocabulary (id, spanish, english, category, difficulty, example_sentence, is_lunfardo, pronunciation_notes)
            VALUES (1, 'laburo', 'work/job', 'trabajo', 2, 'Tengo mucho laburo hoy', 1, 'la-BU-ro')`);

    // Seed conjugation
    db.run(`INSERT INTO conjugations (id, verb_infinitive, tense, mood, vos_form, tu_form, example_sentence)
            VALUES (1, 'hablar', 'presente', 'indicativo', 'hablás', 'hablas', 'Vos hablás muy bien')`);

    // Seed phrase
    db.run(`INSERT INTO phrases (id, spanish, english, category, difficulty, context_notes)
            VALUES (1, '¿Qué onda?', 'What''s up?', 'saludos', 1, 'Informal greeting, very common in Argentina')`);

    // Seed vesre
    db.run(`INSERT INTO vesre (id, original, vesre_form, meaning, example_sentence)
            VALUES (1, 'café', 'feca', 'coffee', 'Vamos a tomar un feca')`);
  });

  afterAll(() => {
    closeDb();
    const fs = require('node:fs');
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  describe('vocab cards', () => {
    it('should resolve vocab content', () => {
      const cardId = createCard(userId, 'vocab', 1);
      const card = getCardById(cardId)!;
      const content = getCardContent(card);

      expect(content).not.toBeNull();
      expect(content!.front).toContain('laburo');
      expect(content!.back).toBe('work/job');
      expect(content!.hint).toContain('laburo');
      expect(content!.category).toBe('trabajo');
      expect(content!.difficulty).toBe(2);
      expect(content!.metadata?.lunfardo).toBe('sí');
      expect(content!.metadata?.pronunciation).toBe('la-BU-ro');
    });

    it('should return null for missing vocab', () => {
      const cardId = createCard(userId, 'vocab', 999);
      // Card exists in srs_cards but content doesn't exist
      // We need to manually create a card pointing to non-existent content
      const db = getDb();
      db.run(`INSERT INTO srs_cards (user_id, card_type, content_id) VALUES (${userId}, 'vocab', 888)`);
      const result = db.exec(`SELECT id FROM srs_cards WHERE content_id = 888`);
      const fakeId = result[0].values[0][0] as number;
      const card = getCardById(fakeId)!;
      const content = getCardContent(card);
      expect(content).toBeNull();
    });
  });

  describe('conjugation cards', () => {
    it('should resolve conjugation content', () => {
      const cardId = createCard(userId, 'conjugation', 1);
      const card = getCardById(cardId)!;
      const content = getCardContent(card);

      expect(content).not.toBeNull();
      expect(content!.front).toContain('hablar');
      expect(content!.front).toContain('presente');
      expect(content!.back).toBe('hablás');
      expect(content!.hint).toContain('hablas');
      expect(content!.metadata?.verb).toBe('hablar');
    });
  });

  describe('phrase cards', () => {
    it('should resolve phrase content', () => {
      const cardId = createCard(userId, 'phrase', 1);
      const card = getCardById(cardId)!;
      const content = getCardContent(card);

      expect(content).not.toBeNull();
      expect(content!.front).toContain("What's up?");
      expect(content!.back).toBe('¿Qué onda?');
      expect(content!.hint).toContain('Informal');
      expect(content!.category).toBe('saludos');
    });
  });

  describe('vesre cards', () => {
    it('should resolve vesre content', () => {
      const cardId = createCard(userId, 'vesre', 1);
      const card = getCardById(cardId)!;
      const content = getCardContent(card);

      expect(content).not.toBeNull();
      expect(content!.front).toContain('café');
      expect(content!.back).toBe('feca');
      expect(content!.hint).toContain('coffee');
      expect(content!.metadata?.original).toBe('café');
    });
  });
});
