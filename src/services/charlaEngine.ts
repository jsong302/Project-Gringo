/**
 * Charla Engine — LLM-powered free conversation in Argentine Spanish.
 *
 * Manages conversation context, "no entiendo" detection,
 * and English fallback explanations.
 */
import { callLlm } from './llm';
import type { LlmMessage } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { log } from '../utils/logger';
import { getSetting } from './settings';

const charlaLog = log.withScope('charla');

// ── Types ───────────────────────────────────────────────────

export interface CharlaResponse {
  text: string;
  isExplanation: boolean;  // true if this was a "no entiendo" fallback
  inputTokens: number;
  outputTokens: number;
}

// ── "No entiendo" detection ─────────────────────────────────

const NO_ENTIENDO_PATTERNS = [
  /\bno\s+entiendo\b/i,
  /\bno\s+comprendo\b/i,
  /\bno\s+te\s+entend[íi]\b/i,
  /\bwhat\b.*\?/i,
  /\bwhat\s+does\s+that\s+mean\b/i,
  /\bi\s+don'?t\s+understand\b/i,
  /\bhelp\b/i,
  /\bexplain\b/i,
  /\bqué\s+significa\b/i,
  /\bcómo\s+se\s+dice\b/i,
  /\?\?\?/,
];

/**
 * Detect if the user is asking for help / doesn't understand.
 * Exported for testing.
 */
export function detectNoEntiendo(text: string): boolean {
  return NO_ENTIENDO_PATTERNS.some((pattern) => pattern.test(text));
}

// ── Message building ────────────────────────────────────────

/**
 * Build the system prompt for charla conversation.
 */
export function buildCharlaSystemPrompt(userLevel: number): string {
  const template = getPromptOrThrow('charla_system');
  return interpolate(template, { level: String(userLevel) });
}

/**
 * Build the message array from conversation history.
 * History is alternating user/assistant messages.
 */
export function buildMessages(history: Array<{ role: 'user' | 'assistant'; text: string }>): LlmMessage[] {
  return history.map((m) => ({
    role: m.role,
    content: m.text,
  }));
}

// ── Core conversation ───────────────────────────────────────

/**
 * Generate a charla response given conversation history.
 */
export async function generateCharlaResponse(
  userMessage: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
): Promise<CharlaResponse> {
  const system = buildCharlaSystemPrompt(userLevel);

  const messages: LlmMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const response = await callLlm({
    system,
    messages,
    temperature: getSetting('llm.charla_temperature', 0.8),
    maxTokens: getSetting('llm.charla_max_tokens', 512),
  });

  charlaLog.debug(`Charla response: ${response.text.slice(0, 80)}...`);

  return {
    text: response.text,
    isExplanation: false,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}

/**
 * Generate an explanation when the user says "no entiendo".
 * Translates the bot's last message and explains any new vocab.
 */
export async function generateExplanation(
  lastBotMessage: string,
  userLevel: number,
): Promise<CharlaResponse> {
  const system = `You are a Spanish tutor helping a level ${userLevel} student who didn't understand your last message.

Your last message was: "${lastBotMessage}"

Instructions:
1. Translate your last message to English
2. Explain any lunfardo, slang, or tricky grammar you used
3. If there were any new vocabulary words, list them with meanings
4. Then say something encouraging in Spanish to continue the conversation

Keep it brief and helpful. Mix English explanation with simple Spanish.`;

  const response = await callLlm({
    system,
    messages: [{ role: 'user', content: 'No entiendo, help me' }],
    temperature: 0.3,
    maxTokens: 512,
  });

  return {
    text: response.text,
    isExplanation: true,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}

// ── Response with "no entiendo" handling ────────────────────

/**
 * Process a user message in a charla conversation.
 * Detects "no entiendo" and handles it automatically.
 */
export async function processCharlaMessage(
  userMessage: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
): Promise<CharlaResponse> {
  // Check if user is asking for help
  if (detectNoEntiendo(userMessage)) {
    // Find the last assistant message
    const lastBotMessage = [...conversationHistory]
      .reverse()
      .find((m) => m.role === 'assistant');

    if (lastBotMessage) {
      charlaLog.info('User triggered "no entiendo" — generating explanation');
      return generateExplanation(lastBotMessage.content as string, userLevel);
    }
  }

  // Normal conversation
  return generateCharlaResponse(userMessage, conversationHistory, userLevel);
}
