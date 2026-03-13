/**
 * TTS Service — text-to-speech via Deepgram Aura-2 API.
 *
 * Reuses the Deepgram API key already configured for STT.
 * Default voice: aura-2-antonia-es (Argentine Spanish).
 */
import { GringoError } from '../errors/gringoError';
import { getTraceId } from '../observability/context';
import { log } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/timeout';
import { getSetting } from './settings';

const ttsLog = log.withScope('tts');

let apiKey: string | null = null;

const TTS_TIMEOUT_MS = 15_000;
const DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak';

export function initTts(deepgramApiKey: string): void {
  apiKey = deepgramApiKey;
  ttsLog.info('TTS initialized (Deepgram Aura-2)');
}

/** @internal — test-only hook */
export function _setApiKey(key: string | null): void {
  apiKey = key;
}

export function isTtsAvailable(): boolean {
  return apiKey !== null;
}

/**
 * Synthesize speech from text. Returns raw audio buffer (mp3).
 */
export async function synthesizeSpeech(
  text: string,
  model?: string,
): Promise<Buffer> {
  const ttsModel = model ?? getSetting('tts.model', 'aura-2-antonia-es');
  if (!apiKey) {
    throw new GringoError({
      message: 'TTS not initialized. Set DEEPGRAM_API_KEY.',
      code: 'ERR_TTS_FAILED',
    });
  }

  const traceId = getTraceId();

  try {
    const params = new URLSearchParams({ model: ttsModel });

    const response = await withTimeout(
      fetch(`${DEEPGRAM_TTS_URL}?${params}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      }),
      TTS_TIMEOUT_MS,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new GringoError({
        message: `Deepgram TTS error: HTTP ${response.status} — ${errorText}`,
        code: 'ERR_TTS_FAILED',
        trace_id: traceId,
        metadata: { status: response.status },
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    ttsLog.info(`TTS generated ${buffer.length} bytes for "${text.slice(0, 50)}"`);
    return buffer;
  } catch (err) {
    if (err instanceof GringoError) throw err;

    if (err instanceof TimeoutError) {
      throw new GringoError({
        message: 'TTS synthesis timed out',
        code: 'ERR_TTS_FAILED',
        cause: err,
        trace_id: traceId,
      });
    }

    throw new GringoError({
      message: `TTS failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'ERR_TTS_FAILED',
      cause: err,
      trace_id: traceId,
    });
  }
}
