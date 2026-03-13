import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDeepgramResponse } from '../../src/services/stt';
import { GringoError } from '../../src/errors/gringoError';

describe('parseDeepgramResponse', () => {
  it('should parse a valid Deepgram response', () => {
    const body = {
      metadata: { duration: 3.5 },
      results: {
        channels: [
          {
            detected_language: 'es',
            alternatives: [
              {
                transcript: 'Hola, ¿cómo estás?',
                confidence: 0.95,
              },
            ],
          },
        ],
      },
    };

    const result = parseDeepgramResponse(body);
    expect(result.transcript).toBe('Hola, ¿cómo estás?');
    expect(result.confidence).toBe(0.95);
    expect(result.durationSec).toBe(3.5);
    expect(result.language).toBe('es');
  });

  it('should handle missing confidence gracefully', () => {
    const body = {
      results: {
        channels: [{ alternatives: [{ transcript: 'test' }] }],
      },
    };

    const result = parseDeepgramResponse(body);
    expect(result.confidence).toBe(0);
  });

  it('should handle missing duration gracefully', () => {
    const body = {
      results: {
        channels: [{ alternatives: [{ transcript: 'test', confidence: 0.9 }] }],
      },
    };

    const result = parseDeepgramResponse(body);
    expect(result.durationSec).toBe(0);
  });

  it('should default language to es when not detected', () => {
    const body = {
      results: {
        channels: [{ alternatives: [{ transcript: 'test', confidence: 0.9 }] }],
      },
    };

    const result = parseDeepgramResponse(body);
    expect(result.language).toBe('es');
  });

  it('should throw on null body', () => {
    expect(() => parseDeepgramResponse(null)).toThrow(GringoError);
  });

  it('should throw on empty results', () => {
    expect(() => parseDeepgramResponse({ results: {} })).toThrow(GringoError);
  });

  it('should throw on missing alternatives', () => {
    expect(() =>
      parseDeepgramResponse({ results: { channels: [{}] } }),
    ).toThrow(GringoError);
  });

  it('should throw on empty alternatives array', () => {
    expect(() =>
      parseDeepgramResponse({ results: { channels: [{ alternatives: [] }] } }),
    ).toThrow(GringoError);
  });

  it('should have ERR_STT_FAILED code on parse failure', () => {
    try {
      parseDeepgramResponse({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GringoError);
      expect((err as GringoError).code).toBe('ERR_STT_FAILED');
    }
  });

  it('should handle empty transcript (valid but empty audio)', () => {
    const body = {
      results: {
        channels: [{ alternatives: [{ transcript: '', confidence: 0.0 }] }],
      },
    };

    const result = parseDeepgramResponse(body);
    expect(result.transcript).toBe('');
  });
});
