import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/db';
import { logLesson } from '../../src/services/lessonEngine';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_DB_DIR = path.join(__dirname, '..', '..', 'tmp-test-lessons');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test.db');

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true });
}

describe('logLesson', () => {
  beforeEach(async () => {
    cleanup();
    await initDb({ path: TEST_DB_PATH });
  });

  afterEach(() => {
    cleanup();
  });

  it('should insert a lesson and return its ID', () => {
    const id = logLesson({
      lessonType: 'daily',
      topic: 'El voseo',
      contentJson: '{"title":"El voseo"}',
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('should store all fields correctly', () => {
    const id = logLesson({
      lessonType: 'lunfardo',
      topic: 'laburo',
      contentJson: '{"word":"laburo"}',
      slackChannelId: 'C123',
      slackMessageTs: '1234567890.000100',
    });

    const db = getDb();
    const result = db.exec(`SELECT * FROM lesson_log WHERE id = ${id}`);
    const row = result[0].values[0];
    const cols = result[0].columns;

    const getValue = (name: string) => row[cols.indexOf(name)];

    expect(getValue('lesson_type')).toBe('lunfardo');
    expect(getValue('topic')).toBe('laburo');
    expect(getValue('content_json')).toBe('{"word":"laburo"}');
    expect(getValue('slack_channel_id')).toBe('C123');
    expect(getValue('slack_message_ts')).toBe('1234567890.000100');
  });

  it('should handle content with special characters', () => {
    const id = logLesson({
      lessonType: 'daily',
      topic: "It's a test",
      contentJson: '{"text":"vos hablás"}',
    });

    expect(id).toBeGreaterThan(0);
  });

  it('should allow null slack fields', () => {
    const id = logLesson({
      lessonType: 'daily',
      topic: 'Test',
      contentJson: '{}',
    });

    const db = getDb();
    const result = db.exec(`SELECT slack_channel_id, slack_message_ts FROM lesson_log WHERE id = ${id}`);
    const row = result[0].values[0];

    expect(row[0]).toBeNull();
    expect(row[1]).toBeNull();
  });

  it('should increment IDs for multiple lessons', () => {
    const id1 = logLesson({ lessonType: 'daily', topic: 'A', contentJson: '{}' });
    const id2 = logLesson({ lessonType: 'daily', topic: 'B', contentJson: '{}' });
    expect(id2).toBeGreaterThan(id1);
  });
});
