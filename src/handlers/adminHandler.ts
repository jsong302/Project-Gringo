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
      'Talk naturally in English or Spanish — the bot has access to admin tools.',
      '',
      '*:wrench: Available Tools*',
      '',
      '*Users & Progress*',
      '- `show all users` — list users with levels and progress',
      '- `show user detail for <name>` — detailed user info',
      '- `place <user> at unit <N>` — move a user to a specific unit',
      '- `update <user> level to <N>` — change a user\'s level',
      '',
      '*Curriculum*',
      '- `show curriculum` — view all units',
      '- `show curriculum progress` — all users\' progress',
      '- `edit unit <N>` — change title, prompts, threshold, etc.',
      '- `add unit after <N>` — insert a new unit',
      '- `reorder unit <N> to position <M>` — move a unit',
      '- `archive unit <N>` — soft-delete a unit',
      '- `remove unit <N>` — permanently delete a unit and re-compact ordering',
      '',
      '*Lesson Bank*',
      '- `generate lesson bank` — generate all missing lessons (background)',
      '- `regenerate lesson for unit <N>` — regenerate a specific lesson',
      '- `regenerate all lessons` — regenerate ALL lessons from scratch (background)',
      '- `view lesson bank` — check which units have lessons',
      '',
      '*Content Queues*',
      '- `show lesson queue` / `show lunfardo queue` — view upcoming queued items',
      '- `fill queue for 2 weeks` — pre-generate lessons and lunfardo for upcoming days',
      '- `show lesson queue item <N>` / `show lunfardo queue item <N>` — full details',
      '- `edit lesson queue item <N>` / `edit lunfardo queue item <N>` — modify content',
      '- `reorder lesson <N> to <date>` / `reorder lunfardo <N> to <date>` — move items',
      '- `remove lesson queue item <N>` / `remove lunfardo queue item <N>` — archive',
      '- `regenerate lesson <N>` / `regenerate lunfardo <N>` — re-generate via LLM',
      '',
      '*Exit Exams*',
      '- `generate exit exam bank` — generate questions for all levels (background)',
      '- `generate exit exam bank for level <N>` — generate questions for one level',
      '- `view exit exam bank` — check question counts per level',
      '- `show exit exam questions for level <N>` — list individual questions',
      '- `edit exam question <N>` — modify a question',
      '- `remove exam question <N>` — archive a question',
      '- `add exam question` — manually add a new question',
      '- `bypass exit exam for user <N>` — skip exam and advance a user',
      '',
      '*Settings & System*',
      '- `show settings` — list all settings',
      '- `change <setting> to <value>` — update a setting',
      '- `add/remove <user> as admin` — manage admins',
      '- `show error patterns` — recent learning/system errors',
      '- `show audit log` — view recent admin actions with before/after snapshots',
      '',
      '*Prompts*',
      '- `show prompts` — list all LLM prompts',
      '- `update prompt <name>` — edit a prompt',
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
