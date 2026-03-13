/**
 * Voice Processor — end-to-end voice memo handling.
 *
 * Downloads audio from Slack, transcribes via Deepgram,
 * and routes to the appropriate handler:
 *  - Pronunciation check (if user asks to check their pronunciation)
 *  - Charla conversation (default — treats voice as text input)
 */
import { transcribeAudio } from './stt';
import type { TranscriptionResult } from './stt';
import { processCharlaMessage } from './charlaEngine';
import { evaluatePronunciation } from './pronunciationChecker';
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
 * Process a voice memo: transcribe and generate a response.
 * If accompanyingText suggests pronunciation checking, evaluates pronunciation.
 * Otherwise routes to charla engine as a normal conversation turn.
 */
export async function processVoiceMemo(
  audioUrl: string,
  slackToken: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
  accompanyingText?: string,
  memoryContext?: string,
  userId?: number,
): Promise<VoiceResult> {
  // Step 1: Transcribe
  voiceLog.info('Processing voice memo...');
  const transcript = await transcribeAudio(audioUrl, slackToken);

  if (!transcript.transcript.trim()) {
    voiceLog.warn('Empty transcript from voice memo');
    throw new GringoError({
      message: 'Could not understand the audio. Try speaking louder or closer to the mic.',
      code: 'ERR_STT_FAILED',
      userMessage: 'I couldn\'t catch what you said. Could you try again?',
    });
  }

  voiceLog.info(
    `Transcribed: "${transcript.transcript.slice(0, 60)}..." (${(transcript.confidence * 100).toFixed(0)}%)`,
  );

  // Step 2: Route based on context
  // If the user sent text like "check my pronunciation" alongside the voice memo,
  // or if the voice memo itself seems to be pronunciation practice, evaluate it.
  const wantsPronunciationCheck = accompanyingText
    ? isPronunciationCheckRequest(accompanyingText)
    : false;

  let response: CharlaResponse;

  if (wantsPronunciationCheck) {
    voiceLog.info('Routing to pronunciation evaluation');
    response = await evaluatePronunciation(transcript, userLevel, userId);
  } else {
    // Default: treat as charla conversation
    response = await processCharlaMessage(
      transcript.transcript,
      conversationHistory,
      userLevel,
      memoryContext,
      userId,
    );
  }

  return { transcript, response };
}

/**
 * Check if the user's text indicates they want pronunciation checked.
 * This is a simple heuristic — the LLM handles nuance.
 */
function isPronunciationCheckRequest(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return /\b(check|evaluate|grade|rate|how('?s| is| does))\b.*\b(pronuncia|pronunc)/i.test(lower)
    || /\bpronuncia(tion|ción)?\b.*\b(check|evaluat|grade|rate|feedback|correct)\b/i.test(lower)
    || /\b(am i saying|did i say|how did i|was that right|is that right|sound ok|sound right)\b/i.test(lower)
    || lower === 'check my pronunciation'
    || lower === 'how does this sound'
    || lower === 'am i saying this right';
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
      text: `_"${result.transcript.transcript}"_ (${(result.transcript.confidence * 100).toFixed(0)}% confidence)`,
    }],
  });

  // Show response
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: result.response.text,
    },
  });

  return blocks;
}
