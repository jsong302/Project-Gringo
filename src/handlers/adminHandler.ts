/**
 * Admin Handler — Wires the admin agent into Slack.
 *
 * Two entry points:
 *  - `/gringo admin <message>` — slash command (ephemeral responses)
 *  - DM to the bot — if sender is admin, routes to admin agent (visible replies)
 *
 * The admin agent is a unified charla + admin agent: it can chat in Spanish
 * AND manage the bot, switching seamlessly based on context.
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { isAdmin } from '../services/settings';
import { runAdminAgent } from '../services/adminAgent';
import { getOrCreateUser } from '../services/userService';
import type { LlmMessage } from '../services/llm';
import { respondEphemeral, postMessage } from '../utils/slackHelpers';

const adminLog = log.withScope('admin-handler');

// ── In-memory conversation history per admin ────────────────
// Keyed by Slack user ID. Keeps last N turns for multi-turn conversations.

const MAX_HISTORY_TURNS = 20;
const conversationHistory = new Map<string, LlmMessage[]>();

function getHistory(slackUserId: string): LlmMessage[] {
  return conversationHistory.get(slackUserId) ?? [];
}

function appendHistory(slackUserId: string, userMsg: string, assistantMsg: string): void {
  const history = getHistory(slackUserId);
  history.push(
    { role: 'user', content: userMsg },
    { role: 'assistant', content: assistantMsg },
  );
  // Trim to max turns (keep most recent)
  while (history.length > MAX_HISTORY_TURNS * 2) {
    history.shift();
  }
  conversationHistory.set(slackUserId, history);
}

export function clearAdminHistory(slackUserId: string): void {
  conversationHistory.delete(slackUserId);
}

// ── Shared agent runner ─────────────────────────────────────

async function runAgentForAdmin(
  slackUserId: string,
  message: string,
): Promise<{ response: string; toolInfo: string }> {
  const user = getOrCreateUser(slackUserId);
  const history = getHistory(slackUserId);
  const result = await runAdminAgent(message, history, user.id);

  appendHistory(slackUserId, message, result.response);

  const toolInfo = result.toolCalls.length > 0
    ? `${result.toolCalls.length} tool call(s) in ${result.turns} turn(s) | ${result.totalInputTokens + result.totalOutputTokens} tokens`
    : '';

  adminLog.info(`Admin response: ${result.turns} turns, ${result.toolCalls.length} tools, ${result.totalInputTokens + result.totalOutputTokens} tokens`);

  return { response: result.response, toolInfo };
}

// ── Slash command handler ───────────────────────────────────

export async function handleAdmin(
  slackUserId: string,
  message: string,
  respond: (msg: any) => Promise<void>,
): Promise<void> {
  // Auth check
  if (!isAdmin(slackUserId)) {
    await respondEphemeral(respond, 'No tenés permisos de admin. Pedile a un admin que te agregue.');
    return;
  }

  const trimmed = message.trim();

  // Special commands
  if (trimmed === '' || trimmed === 'help') {
    await respondEphemeral(respond, [
      '*Admin Agent — Chat con el bot para administrarlo y practicar español*',
      '',
      'Podés hablar en español (charla) o en inglés (admin), o mezclar los dos.',
      '',
      'Ejemplos:',
      '• `/gringo admin show me all users and their progress`',
      '• `/gringo admin change the daily lesson time to 10am`',
      '• `/gringo admin che, cómo andan los pibes?`',
      '• `/gringo admin add @maria as admin`',
      '',
      'También podés mandarme un DM directo para chatear sin el slash command.',
      '',
      '`/gringo admin clear` — Borrar historial de conversación',
    ].join('\n'));
    return;
  }

  if (trimmed === 'clear') {
    clearAdminHistory(slackUserId);
    await respondEphemeral(respond, 'Historial de admin borrado.');
    return;
  }

  // Run agent
  adminLog.info(`Admin command from ${slackUserId}: ${trimmed.slice(0, 100)}`);

  try {
    const { response, toolInfo } = await runAgentForAdmin(slackUserId, trimmed);

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: response } },
    ];

    if (toolInfo) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${toolInfo}_` }],
      });
    }

    await respond({
      response_type: 'ephemeral',
      text: response,
      blocks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    adminLog.error(`Admin agent failed: ${msg}`);
    await respondEphemeral(respond, `Error del admin agent: ${msg}`);
  }
}

// ── DM handler (called from messageHandler) ─────────────────

/**
 * Check if this DM should be handled by the admin agent.
 * Returns true if the sender is an admin.
 */
export function isAdminDm(slackUserId: string, channelType: string): boolean {
  return channelType === 'im' && isAdmin(slackUserId);
}

/**
 * Handle a DM from an admin — routes to the admin agent.
 * Returns the agent's response text, or null if it failed.
 */
export async function handleAdminDm(
  slackUserId: string,
  message: string,
  client: any,
  channelId: string,
  threadTs: string,
): Promise<void> {
  adminLog.info(`Admin DM from ${slackUserId}: ${message.slice(0, 100)}`);

  // Handle "clear" in DM too
  if (message.trim().toLowerCase() === 'clear') {
    clearAdminHistory(slackUserId);
    await postMessage(client, channelId, 'Historial borrado. Empezamos de nuevo.', undefined, threadTs);
    return;
  }

  try {
    const { response, toolInfo } = await runAgentForAdmin(slackUserId, message);

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: response } },
    ];

    if (toolInfo) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${toolInfo}_` }],
      });
    }

    await postMessage(client, channelId, response, blocks, threadTs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    adminLog.error(`Admin DM agent failed: ${msg}`);
    await postMessage(client, channelId, `Error: ${msg}`, undefined, threadTs);
  }
}

// ── Test helper ─────────────────────────────────────────────

/** @internal — test-only: clear all conversation histories */
export function _clearAllHistory(): void {
  conversationHistory.clear();
}
