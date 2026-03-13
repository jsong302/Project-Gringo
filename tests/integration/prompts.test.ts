import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../src/db';
import {
  getPrompt,
  getPromptOrThrow,
  upsertPrompt,
  listPrompts,
  seedDefaultPrompts,
  DEFAULT_PROMPTS,
} from '../../src/services/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_DB_DIR = path.join(__dirname, '..', '..', 'tmp-test-prompts');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test.db');

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true });
}

describe('Prompt Management', () => {
  beforeEach(async () => {
    cleanup();
    await initDb({ path: TEST_DB_PATH });
  });

  afterEach(() => {
    cleanup();
  });

  it('should return null for a non-existent prompt', () => {
    expect(getPrompt('nonexistent')).toBeNull();
  });

  it('should upsert and retrieve a prompt', () => {
    upsertPrompt('test_prompt', 'Hello {{name}}!', 'A test prompt');
    expect(getPrompt('test_prompt')).toBe('Hello {{name}}!');
  });

  it('should update existing prompt on upsert', () => {
    upsertPrompt('test_prompt', 'version 1');
    upsertPrompt('test_prompt', 'version 2');
    expect(getPrompt('test_prompt')).toBe('version 2');
  });

  it('should preserve description when updating without one', () => {
    upsertPrompt('test_prompt', 'v1', 'My description');
    upsertPrompt('test_prompt', 'v2');

    const prompts = listPrompts();
    const found = prompts.find((p) => p.name === 'test_prompt');
    expect(found?.description).toBe('My description');
  });

  it('should throw from getPromptOrThrow when not found', () => {
    expect(() => getPromptOrThrow('missing')).toThrow('missing');
  });

  it('should return text from getPromptOrThrow when found', () => {
    upsertPrompt('exists', 'some text');
    expect(getPromptOrThrow('exists')).toBe('some text');
  });

  it('should list all prompts sorted by name', () => {
    upsertPrompt('b_prompt', 'text b');
    upsertPrompt('a_prompt', 'text a');
    upsertPrompt('c_prompt', 'text c');

    const list = listPrompts();
    expect(list.map((p) => p.name)).toEqual(['a_prompt', 'b_prompt', 'c_prompt']);
  });

  it('should return empty list when no prompts exist', () => {
    expect(listPrompts()).toEqual([]);
  });

  it('should seed all default prompts', () => {
    seedDefaultPrompts();
    const list = listPrompts();
    expect(list.length).toBe(DEFAULT_PROMPTS.length);

    for (const dp of DEFAULT_PROMPTS) {
      const found = list.find((p) => p.name === dp.name);
      expect(found).toBeDefined();
      expect(found!.promptText).toBe(dp.promptText);
    }
  });

  it('should not overwrite admin-edited prompts on re-seed', () => {
    seedDefaultPrompts();

    // Admin edits a prompt
    upsertPrompt('daily_lesson', 'Custom admin version', undefined, 'U_ADMIN');

    // Re-seed
    seedDefaultPrompts();

    // Should still have the admin version
    expect(getPrompt('daily_lesson')).toBe('Custom admin version');
  });

  it('should handle prompts with single quotes', () => {
    upsertPrompt('quote_test', "It's a test with 'quotes'");
    expect(getPrompt('quote_test')).toBe("It's a test with 'quotes'");
  });
});
