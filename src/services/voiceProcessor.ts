/**
 * Voice Processor — end-to-end voice memo handling.
 *
 * Downloads audio from Slack, transcribes via Deepgram,
 * and routes to the appropriate handler (charla or grading).
 */
import { transcribeAudio } from './stt';
import type { TranscriptionResult } from './stt';
import { processCharlaMessage } from './charlaEngine';
import type { CharlaResponse } from './charlaEngine';
import type { LlmMessage } from './llm';
import { log } from '../utils/logger';
import { GringoError } from '../errors/gringoError';

const voiceLog = log.withScope('voice');

// ── Types ───────────────────────────────────────────────────

export interface VoiceResult {
  transcript: TranscriptionResult;
  response: CharlaResponse;
}

// ── Processing ──────────────────────────────────────────────

/**
 * Process a voice memo: transcribe and generate a charla response.
 */
export async function processVoiceMemo(
  audioUrl: string,
  slackToken: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
): Promise<VoiceResult> {
  // Step 1: Transcribe
  voiceLog.info('Processing voice memo...');
  const transcript = await transcribeAudio(audioUrl, slackToken);

  if (!transcript.transcript.trim()) {
    voiceLog.warn('Empty transcript from voice memo');
    throw new GringoError({
      message: 'No se pudo entender el audio. Intentá de nuevo hablando más fuerte.',
      code: 'ERR_STT_FAILED',
      userMessage: 'No pude entender lo que dijiste. ¿Podés intentar de nuevo?',
    });
  }

  voiceLog.info(
    `Transcribed: "${transcript.transcript.slice(0, 60)}..." (${(transcript.confidence * 100).toFixed(0)}%)`,
  );

  // Step 2: Generate response using charla engine
  const response = await processCharlaMessage(
    transcript.transcript,
    conversationHistory,
    userLevel,
  );

  return { transcript, response };
}

/**
 * Format a voice response as Block Kit blocks for Slack.
 */
export function formatVoiceResponseBlocks(
  result: VoiceResult,
): object[] {
  const blocks: object[] = [];

  // Show transcript
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `🎤 _"${result.transcript.transcript}"_ (${(result.transcript.confidence * 100).toFixed(0)}% confidence)`,
    }],
  });

  // Show response
  if (result.response.isExplanation) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📖 *Explicación:*\n${result.response.text}`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🤖 ${result.response.text}`,
      },
    });
  }

  return blocks;
}
