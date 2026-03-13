/**
 * TTS Service — text-to-speech via Azure Speech Service.
 *
 * Uses Azure's REST API with SSML for Argentine Spanish voices
 * (es-AR-ElenaNeural, es-AR-TomasNeural) with speed control.
 */
import { GringoError } from '../errors/gringoError';
import { getTraceId } from '../observability/context';
import { log } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/timeout';
import { getSetting } from './settings';

const ttsLog = log.withScope('tts');

let apiKey: string | null = null;
let region: string = 'eastus';

const TTS_TIMEOUT_MS = 15_000;

export function initTts(azureKey: string, azureRegion?: string): void {
  apiKey = azureKey;
  if (azureRegion) region = azureRegion;
  ttsLog.info(`TTS initialized (Azure Speech — ${region})`);
}

/** @internal — test-only hook */
export function _setApiKey(key: string | null): void {
  apiKey = key;
}

export function isTtsAvailable(): boolean {
  return apiKey !== null;
}

/**
 * Build SSML for Azure TTS with optional speed control.
 */
function buildSsml(text: string, voice: string, speed: number): string {
  // Escape XML special chars in text
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const lang = voice.split('-').slice(0, 2).join('-'); // e.g. "es-AR" from "es-AR-ElenaNeural"

  // Only wrap in prosody if speed != 1.0
  const content = speed !== 1.0
    ? `<prosody rate="${speed.toFixed(2)}">${escaped}</prosody>`
    : escaped;

  return `<speak version='1.0' xml:lang='${lang}'>
  <voice xml:lang='${lang}' name='${voice}'>${content}</voice>
</speak>`;
}

/**
 * Synthesize speech from text. Returns raw audio buffer (mp3).
 *
 * @param text - Text to synthesize
 * @param speed - Speaking rate (0.5 = half speed, 1.0 = normal, 2.0 = double). Default from settings.
 */
export async function synthesizeSpeech(
  text: string,
  speed?: number,
): Promise<Buffer> {
  if (!apiKey) {
    throw new GringoError({
      message: 'TTS not initialized. Set AZURE_SPEECH_KEY.',
      code: 'ERR_TTS_FAILED',
    });
  }

  const voice = getSetting('tts.voice', 'es-AR-ElenaNeural') as string;
  const defaultSpeed = getSetting('tts.speed', 1.0) as number;
  const effectiveSpeed = speed ?? defaultSpeed;
  const traceId = getTraceId();

  const ssml = buildSsml(text, voice, effectiveSpeed);
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  try {
    const response = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'ProjectGringo',
        },
        body: ssml,
      }),
      TTS_TIMEOUT_MS,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new GringoError({
        message: `Azure TTS error: HTTP ${response.status} — ${errorText}`,
        code: 'ERR_TTS_FAILED',
        trace_id: traceId,
        metadata: { status: response.status },
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    ttsLog.info(`TTS generated ${buffer.length} bytes for "${text.slice(0, 50)}" (speed=${effectiveSpeed}, voice=${voice})`);
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
