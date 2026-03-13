/**
 * Charla Engine — Unified LLM-powered conversation agent.
 *
 * Handles free conversation, pronunciation, profile updates, observations,
 * and (for admins) bot management — all through a single multi-turn tool loop.
 * The LLM decides what to do based on context; no regex heuristics.
 */
import { callLlmWithTools } from './llm';
import type { LlmMessage, ToolDefinition, ToolResultBlock } from './llm';
import { getPromptOrThrow, interpolate } from './prompts';
import { log } from '../utils/logger';
import { getSetting } from './settings';
import { saveLearnerFact } from './learnerFacts';
import { updateLevel, updateTimezone, updateDisplayName } from './userService';
import { upsertMemory } from './userMemory';
import { ADMIN_TOOL_DEFINITIONS, executeTool } from './adminTools';
import { isAdmin, listSettings } from './settings';
import { getAllUsers, getUserById } from './userService';
import { getMemoryForPrompt } from './userMemory';

const charlaLog = log.withScope('charla');

const MAX_TOOL_TURNS = 10;

// ── Types ───────────────────────────────────────────────────

export interface CharlaResponse {
  text: string;
  isExplanation: boolean;
  inputTokens: number;
  outputTokens: number;
  pronunciations: string[];
}

// ── Base tools (available to all users) ─────────────────────

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

const BASE_TOOLS: ToolDefinition[] = [PRONOUNCE_TOOL, LOG_OBSERVATION_TOOL, UPDATE_PROFILE_TOOL];

// ── Tool sets ───────────────────────────────────────────────

/** Get the tool set for this user — base tools + admin tools if they're an admin. */
function getToolsForUser(slackUserId?: string): ToolDefinition[] {
  if (slackUserId && isAdmin(slackUserId)) {
    // Admin tools may duplicate base tool names (e.g. 'pronounce') — deduplicate,
    // preferring the base tool definition.
    const baseNames = new Set(BASE_TOOLS.map((t) => t.name));
    const uniqueAdminTools = ADMIN_TOOL_DEFINITIONS.filter((t) => !baseNames.has(t.name));
    return [...BASE_TOOLS, ...uniqueAdminTools];
  }
  return BASE_TOOLS;
}

// ── Built-in tool handlers (non-admin) ──────────────────────

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
      saveLearnerFact(userId, field === 'interests' ? 'interest' : field === 'strengths' ? 'strength' : 'knowledge_gap', value, 'tool');
      charlaLog.info(`Profile update: user ${userId} ${field} → ${value}`);
      break;
  }
}

/** Execute a tool call and return the result string. */
function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  userId?: number,
): string {
  // Built-in charla tools
  if (toolName === 'pronounce') {
    return 'Audio pronunciation will be sent as a voice clip.';
  }
  if (toolName === 'log_student_observation' && userId) {
    const { category, fact } = toolInput as { category: string; fact: string };
    saveLearnerFact(userId, category, fact, 'tool');
    return 'Observation logged.';
  }
  if (toolName === 'update_profile' && userId) {
    const { field, value } = toolInput as { field: string; value: string };
    handleProfileUpdate(userId, field, value);
    return 'Profile updated.';
  }

  // Admin tools — delegated to adminTools.ts executeTool
  return executeTool(toolName, toolInput);
}

// ── Admin context snapshot ───────────────────────────────────

function buildAdminContextSnapshot(adminUserId?: number): string {
  let ctx = '\n\n## Current State\n';

  try {
    const settings = listSettings();
    const settingSummary = settings.map((s) => `- ${s.key}: ${JSON.stringify(s.value)}`).join('\n');
    ctx += `\n### Settings (${settings.length} total)\n${settingSummary}\n`;
  } catch {
    ctx += '\n### Settings: unavailable\n';
  }

  try {
    const users = getAllUsers();
    const userSummary = users.map(
      (u) => `- ${u.displayName ?? u.slackUserId} (id:${u.id}): level ${u.level}, ${u.streakDays}-day streak`,
    ).join('\n');
    ctx += `\n### Users (${users.length} total)\n${userSummary}\n`;
  } catch {
    ctx += '\n### Users: unavailable\n';
  }

  if (adminUserId) {
    try {
      const admin = getUserById(adminUserId);
      if (admin) {
        ctx += `\n### You are chatting with\n`;
        ctx += `- Name: ${admin.displayName ?? admin.slackUserId}, internal user_id: ${admin.id}\n`;
        ctx += `- Level: ${admin.level}, Streak: ${admin.streakDays} days\n`;
        const memory = getMemoryForPrompt(adminUserId);
        if (memory) ctx += `- ${memory}\n`;
      }
    } catch {
      // Admin user not in DB yet
    }
  }

  return ctx;
}

// ── System prompt ───────────────────────────────────────────

export function buildCharlaSystemPrompt(
  userLevel: number,
  memoryContext?: string,
  displayName?: string,
  isAdminUser?: boolean,
  adminUserId?: number,
): string {
  const template = getPromptOrThrow('charla_system');
  let prompt = interpolate(template, { level: String(userLevel) });

  if (displayName) {
    prompt += `\n\nThe student's name is ${displayName}. Use their name occasionally to make the conversation feel personal.`;
  }

  if (memoryContext) {
    prompt += `\n\n--- Learner Profile ---\n${memoryContext}\n\nUse this profile to personalize your teaching. Focus on their weaknesses, build on their strengths, and reference their interests when possible.`;
  }

  if (isAdminUser) {
    prompt += `\n\n--- Admin Mode ---
This user is an admin. In addition to teaching Spanish, you can help them manage the bot.

As an admin, you can:
- View and change system settings (cron schedules, SRS params, etc.)
- See all users and their progress
- Analyze error patterns and suggest interventions
- Edit system prompts that control lessons, grading, and conversation
- View and edit the shared curriculum (units, order, prompts, thresholds)
- See everyone's curriculum progress and manually place users at specific units
- Manage admin access (add/remove admins)
- Change user levels based on proficiency
- View SRS health metrics

How to decide what to do:
- If the message is casual conversation or Spanish practice → teach as normal
- If the message asks about users, settings, data, or management → use admin tools
- You can mix both in a single response

Be concise and actionable. When making changes, confirm what you did.`;

    // Embed live context so the LLM doesn't need to call tools for basic awareness
    prompt += buildAdminContextSnapshot(adminUserId);
  }

  return prompt;
}

export function buildMessages(history: Array<{ role: 'user' | 'assistant'; text: string }>): LlmMessage[] {
  return history.map((m) => ({
    role: m.role,
    content: m.text,
  }));
}

// ── Multi-turn agent loop ───────────────────────────────────

/**
 * Run the charla agent with a multi-turn tool loop.
 * For regular users, tools are: pronounce, log_observation, update_profile.
 * For admins, all admin tools are also available.
 */
export async function generateCharlaResponse(
  userMessage: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
  memoryContext?: string,
  userId?: number,
  displayName?: string,
  slackUserId?: string,
): Promise<CharlaResponse> {
  const isAdminUser = slackUserId ? isAdmin(slackUserId) : false;
  const system = buildCharlaSystemPrompt(userLevel, memoryContext, displayName, isAdminUser, userId);
  const tools = getToolsForUser(slackUserId);

  const messages: LlmMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const pronunciations: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;

  while (turns < MAX_TOOL_TURNS) {
    turns++;

    const maxTokens = isAdminUser
      ? getSetting('llm.admin_max_tokens', 2048)
      : getSetting('llm.charla_max_tokens', 512);

    const response = await callLlmWithTools({
      system,
      messages,
      tools,
      temperature: getSetting('llm.charla_temperature', 0.8),
      maxTokens,
    });

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    // No tool calls → we're done
    if (response.toolUses.length === 0) {
      charlaLog.debug(`Charla response (${turns} turn(s)): ${response.text.slice(0, 80)}...`);
      return {
        text: response.text,
        isExplanation: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        pronunciations,
      };
    }

    // Process tool calls
    const toolResults: ToolResultBlock[] = [];
    let observationCount = 0;
    const MAX_OBSERVATIONS_PER_MESSAGE = 3;

    for (const toolUse of response.toolUses) {
      // Collect pronunciations
      if (toolUse.name === 'pronounce') {
        const phrase = (toolUse.input as any).phrase;
        if (phrase) pronunciations.push(phrase);
      }

      // Rate-limit observations
      if (toolUse.name === 'log_student_observation') {
        if (observationCount >= MAX_OBSERVATIONS_PER_MESSAGE) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Observation limit reached for this message.',
          });
          continue;
        }
        observationCount++;
      }

      const result = handleToolCall(toolUse.name, toolUse.input as Record<string, unknown>, userId);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Feed tool results back into the conversation
    messages.push({ role: 'assistant', content: response.content as any });
    messages.push({ role: 'user', content: toolResults as any });

    charlaLog.debug(`Tool turn ${turns}: ${response.toolUses.map((t) => t.name).join(', ')}`);

    // If the LLM already provided text alongside tool calls AND stop reason is end_turn, return it
    if (response.text && response.stopReason === 'end_turn') {
      if (pronunciations.length > 0) {
        charlaLog.info(`LLM called pronounce tool for: ${pronunciations.join(', ')}`);
      }
      return {
        text: response.text,
        isExplanation: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        pronunciations,
      };
    }
  }

  charlaLog.warn(`Hit max tool turns (${MAX_TOOL_TURNS})`);
  return {
    text: 'Sorry, I got a bit lost there. Can you rephrase that?',
    isExplanation: false,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    pronunciations,
  };
}

// ── Main entry point ────────────────────────────────────────

/**
 * Process a charla message. All intent detection (confusion, questions,
 * profile updates, admin operations) is handled by the LLM via tool use.
 */
export async function processCharlaMessage(
  userMessage: string,
  conversationHistory: LlmMessage[],
  userLevel: number,
  memoryContext?: string,
  userId?: number,
  displayName?: string,
  slackUserId?: string,
): Promise<CharlaResponse> {
  return generateCharlaResponse(userMessage, conversationHistory, userLevel, memoryContext, userId, displayName, slackUserId);
}
