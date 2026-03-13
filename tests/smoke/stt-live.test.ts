/**
 * Live smoke test — hits the real Deepgram API.
 * Only runs when DEEPGRAM_API_KEY is set in .env.
 * Run with: npx vitest run tests/smoke/
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from 'dotenv';
import { initStt, sendToDeepgram, parseDeepgramResponse, _setApiKey } from '../../src/services/stt';

config();

const apiKey = process.env.DEEPGRAM_API_KEY;
const shouldRun = !!apiKey && !apiKey.includes('your-');

describe.skipIf(!shouldRun)('STT Live Smoke Test', () => {
  beforeAll(() => {
    initStt({ apiKey: apiKey! });
  });

  afterAll(() => {
    _setApiKey(null);
  });

  it('should authenticate with Deepgram and get a valid response', async () => {
    // Generate a minimal valid WAV file (silence, 0.1s, 8kHz mono 16-bit)
    // This tests the full pipeline: auth, upload, transcription, response parsing
    const sampleRate = 8000;
    const durationSec = 0.1;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample

    const buffer = Buffer.alloc(44 + dataSize);
    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);       // chunk size
    buffer.writeUInt16LE(1, 20);        // PCM
    buffer.writeUInt16LE(1, 22);        // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32);        // block align
    buffer.writeUInt16LE(16, 34);       // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    // Audio data is all zeros (silence)

    const result = await sendToDeepgram(buffer, apiKey!);

    // Silence should return an empty or very short transcript — that's fine
    expect(typeof result.transcript).toBe('string');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.durationSec).toBe('number');

    console.log(`\n  Transcript: "${result.transcript || '(silence)'}"`);
    console.log(`  Confidence: ${(result.confidence * 100).toFixed(1)}%`);
    console.log(`  Duration: ${result.durationSec.toFixed(2)}s`);
    console.log(`  Language: ${result.language}\n`);
  }, 30_000);
});
