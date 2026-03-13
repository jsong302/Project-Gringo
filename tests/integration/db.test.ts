import { describe, it, expect, afterEach } from 'vitest';
import { initDb, getDb, closeDb, saveDb } from '../../src/db';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_DB_DIR = path.join(__dirname, '..', '..', 'tmp-test-data');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test.db');

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DB_DIR)) fs.rmdirSync(TEST_DB_DIR, { recursive: true } as any);
}

describe('Database', () => {
  afterEach(() => {
    cleanup();
  });

  it('should create the data directory if it does not exist', async () => {
    expect(fs.existsSync(TEST_DB_DIR)).toBe(false);
    await initDb({ path: TEST_DB_PATH });
    expect(fs.existsSync(TEST_DB_DIR)).toBe(true);
  });

  it('should create all tables on init', async () => {
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    const result = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name",
    );
    const tableNames = result[0].values.map((row) => row[0] as string);

    expect(tableNames).toContain('users');
    expect(tableNames).toContain('vocabulary');
    expect(tableNames).toContain('phrases');
    expect(tableNames).toContain('vesre');
    expect(tableNames).toContain('conjugations');
    expect(tableNames).toContain('srs_cards');
    expect(tableNames).toContain('review_log');
    expect(tableNames).toContain('conversation_threads');
    expect(tableNames).toContain('lesson_log');
    expect(tableNames).toContain('lesson_engagement');
    expect(tableNames).toContain('user_vocab_encounters');
    expect(tableNames).toContain('learning_errors');
    expect(tableNames).toContain('system_errors');
    expect(tableNames).toContain('user_memory');
    expect(tableNames).toContain('system_prompts');
    expect(tableNames).toContain('user_feedback');
    expect(tableNames).toContain('migrations');
  });

  it('should be idempotent — running init twice does not error', async () => {
    await initDb({ path: TEST_DB_PATH });
    closeDb();
    // Second init should work fine
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();
    const result = db.exec(
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'",
    );
    const count = result[0].values[0][0] as number;
    expect(count).toBeGreaterThanOrEqual(16);
  });

  it('should persist data after saveDb', async () => {
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    // Insert a user
    db.run(
      "INSERT INTO users (slack_user_id, display_name) VALUES ('U12345', 'Test User')",
    );
    saveDb();

    // Close and reopen
    closeDb();
    await initDb({ path: TEST_DB_PATH });
    const db2 = getDb();

    const result = db2.exec("SELECT display_name FROM users WHERE slack_user_id = 'U12345'");
    expect(result[0].values[0][0]).toBe('Test User');
  });

  it('should enforce foreign keys', async () => {
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    // Verify foreign keys are enabled
    const fkResult = db.exec('PRAGMA foreign_keys');
    expect(fkResult[0].values[0][0]).toBe(1);

    // Insert a valid user first, then try to insert a review_log with an invalid srs_card_id
    db.run("INSERT INTO users (slack_user_id) VALUES ('UFKTEST')");
    const userResult = db.exec("SELECT id FROM users WHERE slack_user_id = 'UFKTEST'");
    const userId = userResult[0].values[0][0] as number;

    // Try to insert a review_log referencing a non-existent srs_card
    expect(() => {
      db.run(
        `INSERT INTO review_log (user_id, srs_card_id, quality) VALUES (${userId}, 9999, 3)`,
      );
    }).toThrow();
  });

  it('should enforce check constraints on users.level', async () => {
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    expect(() => {
      db.run(
        "INSERT INTO users (slack_user_id, level) VALUES ('UBAD', 6)",
      );
    }).toThrow();
  });

  it('should enforce unique constraint on users.slack_user_id', async () => {
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    db.run("INSERT INTO users (slack_user_id) VALUES ('U_UNIQUE')");
    expect(() => {
      db.run("INSERT INTO users (slack_user_id) VALUES ('U_UNIQUE')");
    }).toThrow();
  });

  it('should throw ERR_DB_INIT when getDb is called before init', () => {
    // closeDb already called in cleanup, but just to be explicit
    closeDb();
    expect(() => getDb()).toThrow();
    try {
      getDb();
    } catch (err: any) {
      expect(err.code).toBe('ERR_DB_INIT');
    }
  });

  it('should insert and query across related tables', async () => {
    await initDb({ path: TEST_DB_PATH });
    const db = getDb();

    // Create a user
    db.run("INSERT INTO users (slack_user_id, display_name, level) VALUES ('U100', 'Maria', 3)");

    // Create a vocab entry
    db.run("INSERT INTO vocabulary (spanish, english, category) VALUES ('laburo', 'work', 'lunfardo')");

    // Get the IDs
    const userResult = db.exec("SELECT id FROM users WHERE slack_user_id = 'U100'");
    const userId = userResult[0].values[0][0] as number;

    const vocabResult = db.exec("SELECT id FROM vocabulary WHERE spanish = 'laburo'");
    const vocabId = vocabResult[0].values[0][0] as number;

    // Create an SRS card
    db.run(
      `INSERT INTO srs_cards (user_id, card_type, content_id) VALUES (${userId}, 'vocab', ${vocabId})`,
    );

    // Log a review
    const cardResult = db.exec(`SELECT id FROM srs_cards WHERE user_id = ${userId}`);
    const cardId = cardResult[0].values[0][0] as number;

    db.run(
      `INSERT INTO review_log (user_id, srs_card_id, quality, response_type) VALUES (${userId}, ${cardId}, 4, 'voice')`,
    );

    // Log a learning error
    db.run(
      `INSERT INTO learning_errors (user_id, error_category, description, user_said, correction) VALUES (${userId}, 'conjugation', 'Wrong vos form', 'tu hablas', 'vos hablás')`,
    );

    // Verify the chain
    const reviews = db.exec(`SELECT quality FROM review_log WHERE user_id = ${userId}`);
    expect(reviews[0].values[0][0]).toBe(4);

    const errors = db.exec(`SELECT correction FROM learning_errors WHERE user_id = ${userId}`);
    expect(errors[0].values[0][0]).toBe('vos hablás');
  });
});
