import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  downloadSlackAudio,
  transcribeAudio,
  _setApiKey,
} from '../../src/services/stt';
import { GringoError } from '../../src/errors/gringoError';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('downloadSlackAudio', () => {
  afterEach(() => {
    mockFetch.mockReset();
  });

  it('should download audio with Bearer token', async () => {
    const audioData = Buffer.from('fake-audio-data');
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData.buffer.slice(
        audioData.byteOffset,
        audioData.byteOffset + audioData.byteLength,
      ),
    });

    const result = await downloadSlackAudio(
      'https://files.slack.com/audio.webm',
      'xoxb-token',
    );

    expect(mockFetch).toHaveBeenCalledWith('https://files.slack.com/audio.webm', {
      headers: { Authorization: 'Bearer xoxb-token' },
    });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should throw ERR_VOICE_DOWNLOAD on HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    try {
      await downloadSlackAudio('https://files.slack.com/audio.webm', 'xoxb-token');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GringoError);
      expect((err as GringoError).code).toBe('ERR_VOICE_DOWNLOAD');
      expect((err as GringoError).message).toContain('403');
    }
  });

  it('should throw ERR_VOICE_DOWNLOAD on empty audio', async () => {
    const empty = new ArrayBuffer(0);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => empty,
    });

    try {
      await downloadSlackAudio('https://files.slack.com/audio.webm', 'xoxb-token');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GringoError);
      expect((err as GringoError).code).toBe('ERR_VOICE_DOWNLOAD');
      expect((err as GringoError).message).toContain('empty');
    }
  });
});

describe('transcribeAudio', () => {
  afterEach(() => {
    _setApiKey(null);
    mockFetch.mockReset();
  });

  it('should throw when STT is not initialized', async () => {
    _setApiKey(null);
    try {
      await transcribeAudio('https://files.slack.com/audio.webm', 'xoxb-token');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GringoError);
      expect((err as GringoError).code).toBe('ERR_STT_FAILED');
    }
  });

  it('should download audio then send to Deepgram', async () => {
    _setApiKey('dg-test-key');

    const audioData = Buffer.from('fake-audio');

    // First call: Slack download
    // Second call: Deepgram API
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => audioData.buffer.slice(
          audioData.byteOffset,
          audioData.byteOffset + audioData.byteLength,
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          metadata: { duration: 2.5 },
          results: {
            channels: [
              {
                detected_language: 'es',
                alternatives: [
                  { transcript: 'Hola mundo', confidence: 0.92 },
                ],
              },
            ],
          },
        }),
      });

    const result = await transcribeAudio(
      'https://files.slack.com/audio.webm',
      'xoxb-token',
    );

    expect(result.transcript).toBe('Hola mundo');
    expect(result.confidence).toBe(0.92);
    expect(result.durationSec).toBe(2.5);

    // Verify Deepgram call used the API key
    const deepgramCall = mockFetch.mock.calls[1];
    expect(deepgramCall[0]).toContain('api.deepgram.com');
    expect(deepgramCall[1].headers.Authorization).toBe('Token dg-test-key');
    expect(deepgramCall[1].headers['Content-Type']).toBe('audio/webm');
  });

  it('should throw ERR_STT_FAILED on Deepgram HTTP error', async () => {
    _setApiKey('dg-test-key');

    const audioData = Buffer.from('fake-audio');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => audioData.buffer.slice(
          audioData.byteOffset,
          audioData.byteOffset + audioData.byteLength,
        ),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

    try {
      await transcribeAudio('https://files.slack.com/audio.webm', 'xoxb-token');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GringoError);
      expect((err as GringoError).code).toBe('ERR_STT_FAILED');
      expect((err as GringoError).message).toContain('401');
    }
  });
});
