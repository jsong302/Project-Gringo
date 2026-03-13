/**
 * Admin Handler — Wires admin commands into Slack via the charla engine.
 *
 * `/gringo admin <message>` routes through the same charla engine that
 * handles DMs, but the charla engine detects admin users and gives them
 * access to admin tools + a live context snapshot.
 */
import { log } from '../utils/logger';
import { isAdmin } from '../services/settings';
import { getOrCreateUser } from '../services/userService';
import { processCharlaMessage, type CharlaResponse } from '../services/charlaEngine';
import { getMemoryForPrompt } from '../services/userMemory';
import type { LlmMessage } from '../services/llm';
import { respondEphemeral, postMessage } from '../utils/slackHelpers';
import { generatePronunciationAudio } from '../services/pronunciation';
import { uploadAudioToSlack } from '../utils/slackAudio';

const adminLog = log.withScope('admin-handler');

// ── In-memory conversation history per admin ────────────────
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
  while (history.length > MAX_HISTORY_TURNS * 2) {
    history.shift();
  }
  conversationHistory.set(slackUserId, history);
}

export function clearAdminHistory(slackUserId: string): void {
  conversationHistory.delete(slackUserId);
}

// ── Shared runner (routes through charla engine) ─────────────

async function runForAdmin(
  slackUserId: string,
  message: string,
): Promise<CharlaResponse> {
  const user = getOrCreateUser(slackUserId);
  const history = getHistory(slackUserId);
  const memoryContext = getMemoryForPrompt(user.id);

  const response = await processCharlaMessage(
    message,
    history,
    user.level,
    memoryContext,
    user.id,
    user.displayName ?? undefined,
    slackUserId,
  );

  appendHistory(slackUserId, message, response.text);
  return response;
}

// ── Slash command handler ───────────────────────────────────

export async function handleAdmin(
  slackUserId: string,
  message: string,
  respond: (msg: any) => Promise<void>,
): Promise<void> {
  if (!isAdmin(slackUserId)) {
    await respondEphemeral(respond, 'You don\'t have admin permissions. Ask an admin to add you.');
    return;
  }

  const trimmed = message.trim();

  if (trimmed === '' || trimmed === 'help') {
    await respondEphemeral(respond, [
      '*Admin — Chat with the bot to manage it and practice Spanish*',
      '',
      'You can speak in Spanish (charla) or English (admin), or mix both.',
      '',
      'Examples:',
      '- `/gringo admin show me all users and their progress`',
      '- `/gringo admin change the daily lesson time to 10am`',
      '- `/gringo admin che, como andan los pibes?`',
      '- `/gringo admin add @maria as admin`',
      '- `/gringo admin show curriculum progress`',
      '',
      'You can also DM the bot directly — admins get the same tools in DMs.',
      '',
      '`/gringo admin clear` — Clear conversation history',
    ].join('\n'));
    return;
  }

  if (trimmed === 'clear') {
    clearAdminHistory(slackUserId);
    await respondEphemeral(respond, 'Admin history cleared.');
    return;
  }

  adminLog.info(`Admin command from ${slackUserId}: ${trimmed.slice(0, 100)}`);

  try {
    const response = await runForAdmin(slackUserId, trimmed);

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: response.text } },
    ];

    // Pronunciation audio can't be sent via ephemeral response
    if (response.pronunciations.length > 0) {
      adminLog.info(`Skipping ${response.pronunciations.length} pronunciation clip(s) in slash command (ephemeral — use DM instead)`);
    }

    await respond({
      response_type: 'ephemeral',
      text: response.text,
      blocks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    adminLog.error(`Admin command failed: ${msg}`);
    await respondEphemeral(respond, `Error: ${msg}`);
  }
}

// ── Test helper ─────────────────────────────────────────────

/** @internal — test-only: clear all conversation histories */
export function _clearAllHistory(): void {
  conversationHistory.clear();
}
