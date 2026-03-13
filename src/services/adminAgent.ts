/**
 * Admin Agent — LLM-powered admin interface.
 *
 * Admins chat with the bot in natural language. The LLM has tools
 * to query and modify settings, users, prompts, errors, and SRS data.
 * It runs an agent loop: send message → get response → if tool_use,
 * execute tool → feed result back → repeat until text response.
 */
import { log } from '../utils/logger';
import {
  callLlmWithTools,
  type LlmMessage,
  type ToolResultBlock,
} from './llm';
import { ADMIN_TOOL_DEFINITIONS, executeTool } from './adminTools';
import { listSettings } from './settings';
import { getAllUsers, getUserById } from './userService';
import { getMemoryForPrompt } from './userMemory';

const agentLog = log.withScope('admin-agent');

const MAX_AGENT_TURNS = 10;

// ── System prompt builder ───────────────────────────────────

export function buildAdminSystemPrompt(adminUserId?: number): string {
  const staticBriefing = `You are the admin agent for Gringo, a Slack bot that teaches Argentinian Spanish (Rioplatense dialect) to a small group of 6-15 people.

## What Gringo Does
- **DMs**: Free conversation practice. Users send text or voice memos in Spanish, the bot responds as a conversation partner and corrects errors.
- **#daily-lesson**: Mon-Fri at 9am, an LLM-generated lesson is posted (grammar point + vocabulary + exercise). Difficulty adapts to user levels.
- **#lunfardo-del-dia**: Daily at noon, a lunfardo (Argentine slang) word with etymology, examples, and a mini exercise.
- **#repaso**: SRS flashcard reviews using SM-2 spaced repetition. Users see cards and rate their recall (again/hard/good/easy).
- **#desafio**: Challenge mode — dialogue simulations and pair practice.

## How Learning Works
- **SM-2 SRS**: Cards have ease factor (≥1.3), interval (days), and repetitions. Quality 0-5 maps to: 0-2 = incorrect (reset), 3-5 = correct (increase interval).
- **XP & Levels**: Users earn XP for participation. Levels 1-5 gate content difficulty. XP thresholds trigger auto level-up.
- **Streaks**: Daily practice tracked with timezone awareness.
- **Error Tracking**: Every grammar, vocab, conjugation, and pronunciation error is logged. The system uses these to personalize teaching.
- **User Memory**: LLM-generated learner profiles summarize strengths, weaknesses, and interests. Injected into prompts for personalization.

## Important Constraints
- **srs.min_ease_factor**: Never set below 1.0 — breaks the SM-2 algorithm. Default 1.3 is standard.
- **srs.default_ease_factor**: Should be 2.0-3.0. Default 2.5 is standard SM-2.
- **llm.grading_temperature**: Keep low (0.1-0.5) for consistent grading. Higher = more variable scores.
- **llm.charla_temperature**: Can be higher (0.5-1.0) for more natural conversation.
- **cron schedules**: Use standard cron syntax. Timezone is server-local.
- **content.new_cards_per_day**: Too many new cards overwhelms learners. 3-7 is typical.
- **Levels**: 1=absolute beginner, 2=beginner, 3=intermediate, 4=upper-intermediate, 5=advanced.

## Your Role
You are both a Spanish conversation partner AND an admin interface — seamlessly switching between the two based on context.

**As a conversation partner (charla):**
- Chat naturally in Rioplatense Spanish using voseo (vos hablás, vos tenés)
- Use lunfardo appropriate to the admin's level
- Correct errors gently and naturally within the conversation
- If the admin says "no entiendo" or "help", explain in English then continue in Spanish
- Log any language errors you notice using the log_learning_error tool

**As an admin:**
- View and change any system setting
- See all users and their progress
- Analyze error patterns and suggest interventions
- Edit system prompts that control lesson generation, grading, and conversation
- Manage admin access
- Provide insights and recommendations based on the data

**How to decide which mode:**
- If the message is in Spanish or is casual conversation → charla mode
- If the message asks about users, settings, data, or system management → admin mode
- You can mix both! e.g. "dale, todo bien — btw how are the students doing?" → respond in Spanish, then show admin data

Be concise and actionable. When making changes, confirm what you did. When analyzing data, highlight what's notable and suggest next steps.`;

  // Live snapshot
  let liveContext = '\n\n## Current State\n';

  try {
    const settings = listSettings();
    const settingSummary = settings.map((s) => `- ${s.key}: ${JSON.stringify(s.value)}`).join('\n');
    liveContext += `\n### Settings (${settings.length} total)\n${settingSummary}\n`;
  } catch {
    liveContext += '\n### Settings: unavailable\n';
  }

  try {
    const users = getAllUsers();
    const userSummary = users.map(
      (u) => `- ${u.displayName ?? u.slackUserId} (id:${u.id}): level ${u.level}, ${u.xp} XP, ${u.streakDays}-day streak`,
    ).join('\n');
    liveContext += `\n### Users (${users.length} total)\n${userSummary}\n`;
  } catch {
    liveContext += '\n### Users: unavailable\n';
  }

  // Admin's own learner context (for charla mode)
  if (adminUserId) {
    try {
      const admin = getUserById(adminUserId);
      if (admin) {
        liveContext += `\n### You are chatting with\n`;
        liveContext += `- Name: ${admin.displayName ?? admin.slackUserId}, internal user_id: ${admin.id}\n`;
        liveContext += `- Level: ${admin.level}, XP: ${admin.xp}, Streak: ${admin.streakDays} days\n`;
        const memory = getMemoryForPrompt(adminUserId);
        if (memory) liveContext += `- ${memory}\n`;
      }
    } catch {
      // Admin user not in DB yet
    }
  }

  return staticBriefing + liveContext;
}

// ── Agent loop ──────────────────────────────────────────────

export interface AgentResult {
  response: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export async function runAdminAgent(
  userMessage: string,
  conversationHistory: LlmMessage[] = [],
  adminUserId?: number,
): Promise<AgentResult> {
  const system = buildAdminSystemPrompt(adminUserId);

  const messages: LlmMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const toolCalls: AgentResult['toolCalls'] = [];
  let turns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (turns < MAX_AGENT_TURNS) {
    turns++;

    const response = await callLlmWithTools({
      system,
      messages,
      tools: ADMIN_TOOL_DEFINITIONS,
      maxTokens: 2048,
      temperature: 0.3,
    });

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    // If no tool uses, we're done — return the text response
    if (response.toolUses.length === 0 || response.stopReason === 'end_turn') {
      if (response.text) {
        return {
          response: response.text,
          toolCalls,
          turns,
          totalInputTokens,
          totalOutputTokens,
        };
      }
    }

    // If there are tool uses, execute them and continue the loop
    if (response.toolUses.length > 0) {
      // Add assistant message with content blocks
      messages.push({ role: 'assistant', content: response.content as any });

      // Execute each tool and build result messages
      const toolResults: ToolResultBlock[] = [];
      for (const toolUse of response.toolUses) {
        const result = executeTool(toolUse.name, toolUse.input);
        toolCalls.push({ name: toolUse.name, input: toolUse.input, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults as any });

      agentLog.debug(`Agent turn ${turns}: ${response.toolUses.map((t) => t.name).join(', ')}`);
    }

    // If the response had both text AND ended, return it
    if (response.stopReason === 'end_turn' && response.text) {
      return {
        response: response.text,
        toolCalls,
        turns,
        totalInputTokens,
        totalOutputTokens,
      };
    }
  }

  agentLog.warn(`Agent hit max turns (${MAX_AGENT_TURNS})`);
  return {
    response: 'Perdón, tuve que frenar — estaba haciendo demasiados pasos. ¿Podés reformular tu pregunta?',
    toolCalls,
    turns,
    totalInputTokens,
    totalOutputTokens,
  };
}
