/**
 * Live smoke test — hits the real Anthropic API.
 * Only runs when ANTHROPIC_API_KEY is set in .env.
 * Run with: npx vitest run tests/smoke/
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from 'dotenv';
import { initLlm, callLlm, _setClient } from '../../src/services/llm';

// Load .env
config();

const apiKey = process.env.ANTHROPIC_API_KEY;
const shouldRun = !!apiKey && !apiKey.includes('your-');

describe.skipIf(!shouldRun)('LLM Live Smoke Test', () => {
  beforeAll(() => {
    initLlm({
      apiKey: apiKey!,
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 256,
    });
  });

  afterAll(() => {
    _setClient(null);
  });

  it('should get a response from Claude', async () => {
    const response = await callLlm({
      system: 'You are a helpful assistant. Respond in one short sentence.',
      messages: [{ role: 'user', content: 'Say hello in Argentine Spanish using voseo.' }],
      maxTokens: 100,
    });

    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(5);
    expect(response.inputTokens).toBeGreaterThan(0);
    expect(response.outputTokens).toBeGreaterThan(0);
    expect(response.model).toContain('claude');

    console.log(`\n  Response: "${response.text}"`);
    console.log(`  Tokens: ${response.inputTokens}in / ${response.outputTokens}out`);
    console.log(`  Model: ${response.model}\n`);
  }, 30_000);

  it('should generate a lesson-like JSON response', async () => {
    const response = await callLlm({
      system: 'Respond only with valid JSON. No additional text.',
      messages: [
        {
          role: 'user',
          content:
            'Generate a single Spanish vocabulary word in this JSON format: {"word": "...", "meaning": "...", "example": "..."}',
        },
      ],
      maxTokens: 200,
    });

    const parsed = JSON.parse(
      response.text
        .trim()
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim(),
    );

    expect(parsed).toHaveProperty('word');
    expect(parsed).toHaveProperty('meaning');
    expect(parsed).toHaveProperty('example');

    console.log(`\n  Word: ${parsed.word}`);
    console.log(`  Meaning: ${parsed.meaning}`);
    console.log(`  Example: ${parsed.example}\n`);
  }, 30_000);
});
