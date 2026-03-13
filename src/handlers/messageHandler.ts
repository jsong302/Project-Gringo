/**
 * Message Handler — listens for messages and voice memos in channels.
 *
 * Handles:
 *  - Text messages in #charla-libre → charla conversation
 *  - Voice memos (file_shared audio) → transcribe → charla or grade
 *  - "No entiendo" detection → English explanation
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { runWithObservabilityContext } from '../observability/context';
import { getOrCreateUser } from '../services/userService';
import { updateStreak, addXp } from '../services/userService';
import {
  startConversation,
  getConversationByThread,
  addTurn,
} from '../services/conversationTracker';
import { processCharlaMessage } from '../services/charlaEngine';
import { processVoiceMemo, formatVoiceResponseBlocks } from '../services/voiceProcessor';
import { getMemoryForPrompt } from '../services/userMemory';
import { logGradingErrors } from '../services/errorTracker';
import type { LlmMessage } from '../services/llm';
import { postMessage } from '../utils/slackHelpers';
import { getXpForTextMessage, getXpForVoiceMemo } from '../services/settings';
import { isAdminDm, handleAdminDm } from './adminHandler';

const msgLog = log.withScope('message-handler');

// Cache the bot's own user ID so we can detect @mentions
let botUserId = '';

async function getBotUserId(client: any): Promise<string> {
  if (botUserId) return botUserId;
  try {
    const result = await client.auth.test();
    botUserId = result.user_id ?? '';
    return botUserId;
  } catch {
    return '';
  }
}

/**
 * Check if the bot should respond to this message.
 * Returns true for: DMs or @mentions in any channel.
 */
async function shouldRespond(
  text: string,
  channelType: string,
  client: any,
): Promise<boolean> {
  // Always respond in DMs
  if (channelType === 'im') return true;

  // In channels, only respond when @mentioned
  const botId = await getBotUserId(client);
  if (botId && text.includes(`<@${botId}>`)) return true;

  return false;
}

// ── Registration ────────────────────────────────────────────

export function registerMessageHandlers(app: App): void {
  app.message(async ({ message, client, say }) => {
    // Only handle user messages (not bot messages, not edits)
    if (message.subtype || !('text' in message) || !message.text) return;
    if ('bot_id' in message) return;

    const slackUserId = (message as any).user as string;
    const channelId = message.channel;
    const channelType = (message as any).channel_type ?? '';
    const threadTs = (message as any).thread_ts ?? (message as any).ts;
    const text = (message as any).text as string;

    await runWithObservabilityContext(async () => {
      try {
        // Route admin DMs to the admin agent
        if (isAdminDm(slackUserId, channelType)) {
          await handleAdminDm(slackUserId, text, client, channelId, threadTs);
          return;
        }

        // Only respond in DMs or when @mentioned
        if (!await shouldRespond(text, channelType, client)) return;

        const user = getOrCreateUser(slackUserId);

        // Check if there's an active conversation in this thread
        let conversation = getConversationByThread(channelId, threadTs);

        if (!conversation) {
          // Start a new charla conversation
          conversation = startConversation(user.id, channelId, threadTs, 'charla');
        }

        // Build conversation history from thread (simplified — uses the conversation turn count)
        // In production, you'd fetch actual Slack thread history
        const history: LlmMessage[] = [];

        // Add memory context as a system-level hint
        const memoryContext = getMemoryForPrompt(user.id);

        // Process message
        const response = await processCharlaMessage(text, history, user.level);

        // Track turn
        addTurn(conversation.id);

        // Update streak and XP
        updateStreak(user.id);
        addXp(user.id, getXpForTextMessage());

        // Reply in thread
        await say({
          text: response.text,
          thread_ts: threadTs,
        });

        msgLog.debug(`Replied to ${slackUserId} in ${channelId}`);
      } catch (err) {
        msgLog.error(`Message handler failed: ${err}`);
        await say({
          text: 'Something went wrong. Please try again in a moment.',
          thread_ts: threadTs,
        });
      }
    });
  });

  // Listen for voice memos (file_shared events)
  app.event('file_shared', async ({ event, client }) => {
    await runWithObservabilityContext(async () => {
      try {
        // Get file info
        const fileInfo = await client.files.info({ file: event.file_id });
        const file = fileInfo.file;

        if (!file) return;

        // Only process audio files
        const mimeType = file.mimetype ?? '';
        if (!mimeType.startsWith('audio/') && !mimeType.includes('webm') && !mimeType.includes('ogg')) {
          return;
        }

        const slackUserId = file.user ?? (event as any).user_id;
        if (!slackUserId) return;

        const channelId = file.channels?.[0] ?? (event as any).channel_id;
        if (!channelId) return;

        const threadTs = (file as any).shares?.public?.[channelId]?.[0]?.ts
          ?? (file as any).timestamp?.toString()
          ?? Date.now().toString();

        const user = getOrCreateUser(slackUserId);

        msgLog.info(`Processing voice memo from ${slackUserId} (${mimeType}, ${file.size} bytes)`);

        // Get or start conversation
        let conversation = getConversationByThread(channelId, threadTs);
        if (!conversation) {
          conversation = startConversation(user.id, channelId, threadTs, 'charla');
        }

        // Process voice memo
        const audioUrl = file.url_private ?? '';
        const botToken = process.env.SLACK_BOT_TOKEN ?? '';
        const history: LlmMessage[] = [];

        const result = await processVoiceMemo(audioUrl, botToken, history, user.level);

        // Track turn
        addTurn(conversation.id);

        // Update streak and XP
        updateStreak(user.id);
        addXp(user.id, getXpForVoiceMemo());

        // Reply with transcript + response
        const blocks = formatVoiceResponseBlocks(result);
        await postMessage(
          client,
          channelId,
          result.response.text,
          blocks as any[],
          threadTs,
        );

        msgLog.info(`Voice memo processed for ${slackUserId}`);
      } catch (err) {
        msgLog.error(`Voice handler failed: ${err}`);
      }
    });
  });

  msgLog.info('Message and voice handlers registered');
}
