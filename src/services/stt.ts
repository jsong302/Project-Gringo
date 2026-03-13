import type { DeepgramConfig } from '../config/types';
import { GringoError } from '../errors/gringoError';
import { getTraceId } from '../observability/context';
import { log } from '../utils/logger';
import { withTimeout, TimeoutError } from '../utils/timeout';

const sttLog = log.withScope('stt');

let apiKey: string | null = null;

const STT_TIMEOUT_MS = 30_000;
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

export function initStt(config: DeepgramConfig): void {
  apiKey = config.apiKey;
  sttLog.info('STT initialized (Deepgram Nova-3)');
}

/** @internal — test-only hook */
export function _setApiKey(key: string | null): void {
  apiKey = key;
}

// ── Audio download (exported for testing) ───────────────────

export async function downloadSlackAudio(
  audioUrl: string,
  slackToken: string,
): Promise<Buffer> {
  const traceId = getTraceId();

  const response = await fetch(audioUrl, {
    headers: { Authorization: `Bearer ${slackToken}` },
  });

  if (!response.ok) {
    throw new GringoError({
      message: `Failed to download audio: HTTP ${response.status}`,
      code: 'ERR_VOICE_DOWNLOAD',
      trace_id: traceId,
      metadata: { audioUrl, status: response.status },
    });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new GringoError({
      message: 'Downloaded audio file is empty',
      code: 'ERR_VOICE_DOWNLOAD',
      trace_id: traceId,
      metadata: { audioUrl },
    });
  }

  sttLog.debug(`Downloaded audio: ${buffer.length} bytes`, { traceId });
  return buffer;
}

// ── Deepgram transcription (exported for testing) ───────────

export interface WordInfo {
  word: string;
  confidence: number;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  transcript: string;
  confidence: number;
  durationSec: number;
  language: string;
  words: WordInfo[];
}

export function parseDeepgramResponse(body: any): TranscriptionResult {
  const alt = body?.results?.channels?.[0]?.alternatives?.[0];

  if (!alt || typeof alt.transcript !== 'string') {
    throw new GringoError({
      message: 'Unexpected Deepgram response shape',
      code: 'ERR_STT_FAILED',
      metadata: { body: JSON.stringify(body).slice(0, 500) },
    });
  }

  const words: WordInfo[] = (alt.words ?? []).map((w: any) => ({
    word: w.word ?? w.punctuated_word ?? '',
    confidence: w.confidence ?? 0,
    start: w.start ?? 0,
    end: w.end ?? 0,
  }));

  return {
    transcript: alt.transcript,
    confidence: alt.confidence ?? 0,
    durationSec: body.metadata?.duration ?? 0,
    language: body.results?.channels?.[0]?.detected_language ?? 'es',
    words,
  };
}

export async function sendToDeepgram(
  audioBuffer: Buffer,
  deepgramApiKey: string,
): Promise<TranscriptionResult> {
  const traceId = getTraceId();

  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'es',
    punctuate: 'true',
    smart_format: 'true',
    words: 'true',
  });

  const response = await withTimeout(
    fetch(`${DEEPGRAM_URL}?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
        'Content-Type': 'audio/*',
      },
      body: new Uint8Array(audioBuffer),
    }),
    STT_TIMEOUT_MS,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    throw new GringoError({
      message: `Deepgram API error: HTTP ${response.status} — ${errorText}`,
      code: 'ERR_STT_FAILED',
      trace_id: traceId,
      metadata: { status: response.status },
    });
  }

  const body = await response.json();
  const result = parseDeepgramResponse(body);

  sttLog.debug(
    `Transcribed ${result.durationSec.toFixed(1)}s audio — confidence: ${(result.confidence * 100).toFixed(0)}%`,
    { traceId },
  );

  return result;
}

// ── Main entry point ────────────────────────────────────────

export async function transcribeAudio(
  audioUrl: string,
  slackToken: string,
): Promise<TranscriptionResult> {
  if (!apiKey) {
    throw new GringoError({
      message: 'STT not initialized. Call initStt() first or set DEEPGRAM_API_KEY.',
      code: 'ERR_STT_FAILED',
    });
  }

  const traceId = getTraceId();

  try {
    const audioBuffer = await downloadSlackAudio(audioUrl, slackToken);
    return await sendToDeepgram(audioBuffer, apiKey);
  } catch (err) {
    if (err instanceof GringoError) throw err;

    if (err instanceof TimeoutError) {
      throw new GringoError({
        message: 'STT transcription timed out',
        code: 'ERR_STT_FAILED',
        cause: err,
        trace_id: traceId,
      });
    }

    throw new GringoError({
      message: `STT failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'ERR_STT_FAILED',
      cause: err,
      trace_id: traceId,
    });
  }
}
