/**
 * Pronunciation Checker — evaluates student pronunciation from voice memos.
 *
 * Uses Deepgram word-level confidence data + LLM analysis to give
 * actionable pronunciation feedback. The LLM can call the pronounce tool
 * to demo correct pronunciation of words the student struggled with.
 */
import { callLlmWithTools, callLlm } from './llm';
import type { LlmMessage, ToolResultBlock } from './llm';
import type { TranscriptionResult } from './stt';
import type { CharlaResponse } from './charlaEngine';
import { getPromptOrThrow, interpolate } from './prompts';
import { getSetting } from './settings';
import { logLearningError } from './errorTracker';
import { log } from '../utils/logger';

const pronLog = log.withScope('pronunciation-check');

// Reuse the same pronounce tool from charla engine
const PRONOUNCE_TOOL = {
  name: 'pronounce',
  description: 'Generate an audio pronunciation clip for a Spanish word or phrase. Use this to demonstrate correct pronunciation of words the student struggled with.',
  input_schema: {
    type: 'object' as const,
    properties: {
      phrase: {
        type: 'string',
        description: 'The Spanish word or phrase to pronounce correctly (e.g. "laburo", "¿Cómo andás?")',
      },
    },
    required: ['phrase'],
  },
};

/**
 * Format word-level confidence data for the LLM prompt.
 */
function formatWordDetails(transcript: TranscriptionResult): string {
  if (transcript.words.length === 0) {
    return '(word-level data not available)';
  }

  return transcript.words
    .map((w) => `"${w.word}" — ${(w.confidence * 100).toFixed(0)}% confidence`)
    .join('\n');
}

/**
 * Evaluate a student's pronunciation from a voice memo transcription.
 * Returns a CharlaResponse with feedback and optional pronunciation demos.
 */
export async function evaluatePronunciation(
  transcript: TranscriptionResult,
  userLevel: number,
  userId?: number,
): Promise<CharlaResponse> {
  const template = getPromptOrThrow('pronunciation_check');
  const system = interpolate(template, {
    level: String(userLevel),
    transcript: transcript.transcript,
    word_details: formatWordDetails(transcript),
    confidence: (transcript.confidence * 100).toFixed(0),
  });

  const wordDetails = formatWordDetails(transcript);
  const messages: LlmMessage[] = [
    { role: 'user', content: `Check my pronunciation. Here is what the speech recognition picked up:

Transcript: "${transcript.transcript}"

Word-by-word confidence:
${wordDetails}

Overall confidence: ${(transcript.confidence * 100).toFixed(0)}%` },
  ];

  const response = await callLlmWithTools({
    system,
    messages,
    tools: [PRONOUNCE_TOOL],
    temperature: 0.3,
    maxTokens: getSetting('llm.pronunciation_max_tokens', 1024),
  });

  // Collect pronunciation tool calls
  const pronunciations: string[] = [];
  for (const toolUse of response.toolUses) {
    if (toolUse.name === 'pronounce') {
      const phrase = (toolUse.input as any).phrase;
      if (phrase) pronunciations.push(phrase);
    }
  }

  let text = response.text;

  // If tool calls but no text, do a follow-up to get the text response
  if (response.toolUses.length > 0 && !text) {
    const toolResults: ToolResultBlock[] = response.toolUses.map((tu) => ({
      type: 'tool_result' as const,
      tool_use_id: tu.id,
      content: tu.name === 'pronounce'
        ? 'Audio pronunciation will be sent as a voice clip.'
        : 'Done.',
    }));

    const followUp = await callLlm({
      system,
      messages: [
        ...messages,
        { role: 'assistant', content: response.content as any },
        { role: 'user', content: toolResults as any },
      ],
      temperature: 0.3,
      maxTokens: getSetting('llm.pronunciation_max_tokens', 1024),
    });

    text = followUp.text;
  }

  if (pronunciations.length > 0) {
    pronLog.info(`Pronunciation check — demo clips: ${pronunciations.join(', ')}`);
  }

  // Flag low-confidence words and log as learning errors
  const lowConfWords = transcript.words.filter((w) => w.confidence < 0.8);
  if (lowConfWords.length > 0) {
    pronLog.info(`Low confidence words: ${lowConfWords.map((w) => `"${w.word}" (${(w.confidence * 100).toFixed(0)}%)`).join(', ')}`);
    if (userId) {
      for (const w of lowConfWords) {
        logLearningError(userId, 'pronunciation', `Low confidence on "${w.word}" (${(w.confidence * 100).toFixed(0)}%)`, w.word, undefined, 'voice');
      }
    }
  }

  pronLog.info(`Pronunciation evaluation complete — ${text.slice(0, 80)}...`);

  return {
    text,
    isExplanation: false,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    pronunciations,
  };
}
