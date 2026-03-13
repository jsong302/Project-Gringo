/**
 * Charla Engine — LLM-powered free conversation in Argentine Spanish.
 *
 * Manages conversation context and pronunciation via tool use.
 * The LLM decides when to explain, switch languages, or adjust — no regex.
 */
import { callLlm, callLlmWithTools } from './llm';
import type { LlmMessage, ToolDefinition, ToolUseBlock, ToolResultBlock } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { log } from '../utils/logger';
import { getSetting } from './settings';
import { saveLearnerFact } from './learnerFacts';
import { updateLevel, updateTimezone, updateDisplayName } from './userService';
import { upsertMemory } from './userMemory';

const charlaLog = log.withScope('charla');

// ── Types ───────────────────────────────────────────────────

export interface CharlaResponse {
  text: string;
  isExplanation: boolean;
  inputTokens: number;
  outputTokens: number;
  pronunciations: string[];  // phrases the LLM wants pronounced
}

// ── Tools ──────────────────────────────────────────────────

const PRONOUNCE_TOOL: ToolDefinition = {
  name: 'pronounce',
  description: 'Generate an audio pronunciation clip for a Spanish word or phrase. Use this whenever the student asks how to pronounce something, or when introducing a new word that would benefit from hearing it spoken.',
  input_schema: {
    type: 'object',
    properties: {
      phrase: {
        type: 'string',
        description: 'The Spanish word or phrase to pronounce (e.g. "laburo", "¿Cómo andás?")',
      },
    },
    required: ['phrase'],
  },
};

const LOG_OBSERVATION_TOOL: ToolDefinition = {
  name: 'log_student_observation',
  description: 'Log an observation about the student during conversation. Call this when you notice: a grammar/vocabulary error, a topic they are interested in, a strength, a knowledge gap, or a pronunciation issue. You can call this multiple times. Always provide your conversational response alongside tool calls.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['error_pattern', 'strength', 'interest', 'preference', 'knowledge_gap', 'pronunciation'],
        description: 'Type of observation',
      },
      fact: {
        type: 'string',
        description: 'Concise observation, e.g. "Confuses ser/estar with locations" or "Interested in football vocabulary" or "Correctly uses voseo in present tense"',
      },
    },
    required: ['category', 'fact'],
  },
};

const UPDATE_PROFILE_TOOL: ToolDefinition = {
  name: 'update_profile',
  description: 'Update the student\'s profile when they share information about themselves. Use this when the student mentions their level preference, timezone, name, interests, strengths, or weaknesses. For example: "I\'m already intermediate", "I\'m in Chicago", "I really want to learn food vocabulary", "My name is Sarah".',
  input_schema: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        enum: ['level', 'timezone', 'display_name', 'interests', 'strengths', 'weaknesses'],
        description: 'Which profile field to update',
      },
      value: {
        type: 'string',
        description: 'The new value. For level: "1"-"5". For timezone: IANA format (e.g. "America/Chicago"). For display_name: their name. For interests/strengths/weaknesses: a concise description.',
      },
    },
    required: ['field', 'value'],
  },
};

const CHARLA_TOOLS: ToolDefinition[] = [PRONOUNCE_TOOL, LOG_OBSERVATION_TOOL, UPDATE_PROFILE_TOOL];

// ── Profile updates ─────────────────────────────────────────

function handleProfileUpdate(userId: number, field: string, value: string): void {
  switch (field) {
    case 'level': {
      const lvl = parseInt(value, 10);
      if (lvl >= 1 && lvl <= 5) {
        updateLevel(userId, lvl);
        charlaLog.info(`Profile update: user ${userId} level → ${lvl}`);
      }
      break;
    }
    case 'timezone':
      try {
        new Date().toLocaleTimeString('en-GB', { timeZone: value });
        updateTimezone(userId, value);
        charlaLog.info(`Profile update: user ${userId} timezone → ${value}`);
      } catch {
        charlaLog.warn(`Invalid timezone from LLM: ${value}`);
      }
      break;
    case 'display_name':
      updateDisplayName(userId, value);
      charlaLog.info(`Profile update: user ${userId} name → ${value}`);
      break;
    case 'interests':
    case 'strengths':
    case 'weaknesses':
      // Store as a learner fact so it feeds into the memory profile
      saveLearnerFact(userId, field === 'interests' ? 'interest' : field === 'strengths' ? 'strength' : 'knowledge_gap', value, 'tool');
      charlaLog.info(`Profile update: user ${userId} ${field} → ${value}`);
      break;
  }
}

// ── Message building ────────────────────────────────────────

export function buildCharlaSystemPrompt(userLevel: number, memoryContext?: string, displayName?: string): string {
  const template = getPromptOrThrow('charla_system');
  let prompt = interpolate(template, { level: String(userLevel) });

  if (displayName) {
    prompt += `\n\nThe student's name is ${displayName}. Use their name occasionally to make the conversation feel personal.`;
  }

  if (memoryContext) {
    prompt += `\n\n--- Learner Profile ---\n${memoryContext}\n\nUse this profile to personalize your teaching. Focus on their weaknesses, build on their strengths, and reference their interests when possible.`;
  }

  return prompt;
}

export function buildMessages(history: Array<{ role: 'user' | 'assistant'; text: string }>): LlmMessage[] {
  return history.map((m) => ({
    role: m.role,
    content: m.text,
  }));
}

// ── Core conversation ───────────────────────────────────────

/**
 * Generate a charla response with tool use (pronunciation, observations, profile updates).
 * The LLM handles all intent detection — confusion, questions, profile updates, etc.
 */
export async function generateCharlaResponse(
  userMessage: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
  memoryContext?: string,
  userId?: number,
  displayName?: string,
): Promise<CharlaResponse> {
  const system = buildCharlaSystemPrompt(userLevel, memoryContext, displayName);

  const messages: LlmMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const response = await callLlmWithTools({
    system,
    messages,
    tools: CHARLA_TOOLS,
    temperature: getSetting('llm.charla_temperature', 0.8),
    maxTokens: getSetting('llm.charla_max_tokens', 512),
  });

  // Process tool calls: collect pronunciations and log observations
  const pronunciations: string[] = [];
  let observationCount = 0;
  const MAX_OBSERVATIONS_PER_MESSAGE = 3;

  for (const toolUse of response.toolUses) {
    if (toolUse.name === 'pronounce') {
      const phrase = (toolUse.input as any).phrase;
      if (phrase) pronunciations.push(phrase);
    } else if (toolUse.name === 'log_student_observation' && userId) {
      if (observationCount < MAX_OBSERVATIONS_PER_MESSAGE) {
        const { category, fact } = toolUse.input as { category: string; fact: string };
        saveLearnerFact(userId, category, fact, 'tool');
        observationCount++;
      }
    } else if (toolUse.name === 'update_profile' && userId) {
      const { field, value } = toolUse.input as { field: string; value: string };
      handleProfileUpdate(userId, field, value);
    }
  }

  // If there were tool calls but also text, we have our response
  // If tool calls but no text, we need a follow-up call with tool results
  let text = response.text;

  if (response.toolUses.length > 0 && !text) {
    // Build tool results and get the final text response
    const toolResults: ToolResultBlock[] = response.toolUses.map((tu) => ({
      type: 'tool_result' as const,
      tool_use_id: tu.id,
      content: tu.name === 'pronounce'
        ? 'Audio pronunciation will be sent as a voice clip.'
        : tu.name === 'update_profile'
        ? 'Profile updated.'
        : 'Observation logged.',
    }));

    const followUp = await callLlm({
      system,
      messages: [
        ...messages,
        { role: 'assistant', content: response.content as any },
        { role: 'user', content: toolResults as any },
      ],
      temperature: getSetting('llm.charla_temperature', 0.8),
      maxTokens: getSetting('llm.charla_max_tokens', 512),
    });

    text = followUp.text;
  }

  if (pronunciations.length > 0) {
    charlaLog.info(`LLM called pronounce tool for: ${pronunciations.join(', ')}`);
  }

  charlaLog.debug(`Charla response: ${text.slice(0, 80)}...`);

  return {
    text,
    isExplanation: false,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    pronunciations,
  };
}

// ── Main entry point ────────────────────────────────────────

/**
 * Process a charla message. All intent detection (confusion, questions,
 * profile updates) is handled by the LLM via tool use and system prompt.
 */
export async function processCharlaMessage(
  userMessage: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
  memoryContext?: string,
  userId?: number,
  displayName?: string,
): Promise<CharlaResponse> {
  return generateCharlaResponse(userMessage, conversationHistory, userLevel, memoryContext, userId, displayName);
}
