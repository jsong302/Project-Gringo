/**
 * Message Handler — listens for messages and voice memos in channels.
 *
 * Handles:
 *  - Text messages → charla conversation
 *  - Voice memos (audio files attached to messages) → transcribe → charla or pronunciation check
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
  saveMessage,
  getMessages,
} from '../services/conversationTracker';
import { processCharlaMessage } from '../services/charlaEngine';
import { processVoiceMemo, formatVoiceResponseBlocks } from '../services/voiceProcessor';
import { getMemoryForPrompt, generateMemory, getMemory } from '../services/userMemory';
import { getLessonByMessageTs, gradeLessonResponse, formatGradingBlocks, logLessonEngagement } from '../services/lessonEngine';
import type { LlmMessage } from '../services/llm';
import { postMessage } from '../utils/slackHelpers';
import { getXpForTextMessage, getXpForVoiceMemo, getSetting } from '../services/settings';
import { isAdminDm, handleAdminDm } from './adminHandler';
import { sendWelcomeDm } from './onboardingHandler';
import { generatePronunciationAudio } from '../services/pronunciation';
import { uploadAudioToSlack } from '../utils/slackAudio';

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

/**
 * Check if a message has audio files attached (voice memos).
 */
function getAudioFile(message: any): any | null {
  const files = message.files;
  if (!Array.isArray(files) || files.length === 0) return null;

  for (const file of files) {
    const mime = file.mimetype ?? '';
    if (mime.startsWith('audio/') || mime.includes('webm') || mime.includes('ogg')) {
      return file;
    }
  }
  return null;
}

/**
 * Handle pronunciation audio generation and upload for a response.
 */
async function uploadPronunciationClips(
  response: { pronunciations: string[] },
  client: any,
  channelId: string,
  threadTs: string,
): Promise<void> {
  if (response.pronunciations.length === 0) return;

  const audioBuffers = await generatePronunciationAudio(response.pronunciations);
  for (let i = 0; i < audioBuffers.length; i++) {
    if (audioBuffers[i]) {
      await uploadAudioToSlack(
        client,
        channelId,
        audioBuffers[i]!,
        response.pronunciations[i],
        threadTs,
      );
    }
  }
}

// ── Registration ────────────────────────────────────────────

export function registerMessageHandlers(app: App): void {
  app.message(async ({ message, client, say }) => {
    // Only handle user messages (not bot messages, not edits)
    // Allow file_share subtype (voice memos) but skip other subtypes
    if (message.subtype && message.subtype !== 'file_share') return;
    if ('bot_id' in message) return;

    const slackUserId = (message as any).user as string;
    const channelId = message.channel;
    const channelType = (message as any).channel_type ?? '';
    const threadTs = (message as any).thread_ts ?? (message as any).ts;
    const text = ((message as any).text ?? '') as string;
    const audioFile = getAudioFile(message);

    // Need either text or audio to respond
    if (!text && !audioFile) return;

    await runWithObservabilityContext(async () => {
      try {
        // Route admin DMs to the admin agent
        if (isAdminDm(slackUserId, channelType)) {
          await handleAdminDm(slackUserId, text, client, channelId, threadTs);
          return;
        }

        // ── Lesson thread detection ──────────────────────────
        // Replies in lesson threads are always graded (no @mention needed)
        const isThreadReply = (message as any).thread_ts != null;
        if (isThreadReply) {
          const lesson = getLessonByMessageTs(channelId, threadTs);
          if (lesson) {
            const user = getOrCreateUser(slackUserId);
            const lessonContent = JSON.parse(lesson.contentJson);
            const exercise = lessonContent.exercise ?? '';
            const studentText = text || '';

            // Handle voice memo in lesson thread: transcribe first
            let responseText = studentText;
            if (audioFile && !studentText) {
              const { transcribeAudio } = await import('../services/stt');
              const audioUrl = audioFile.url_private ?? '';
              const botToken = process.env.SLACK_BOT_TOKEN ?? '';
              const transcript = await transcribeAudio(audioUrl, botToken);
              responseText = transcript.transcript;
              logLessonEngagement(lesson.id, user.id, 'voice_response');
            } else {
              logLessonEngagement(lesson.id, user.id, 'text_response');
            }

            if (responseText) {
              const grading = await gradeLessonResponse(exercise, responseText, user.level, user.id);
              const blocks = formatGradingBlocks(grading);

              updateStreak(user.id);
              addXp(user.id, getXpForTextMessage());

              await postMessage(client, channelId, grading.responseEs || grading.praise, blocks as any[], threadTs);
              msgLog.info(`Graded lesson response from ${slackUserId}: ${grading.correct} (${grading.score}/5)`);
            }
            return;
          }
        }

        // Only respond in DMs or when @mentioned
        if (!await shouldRespond(text, channelType, client)) return;

        const user = getOrCreateUser(slackUserId);

        // ── Onboarding gate ───────────────────────────────────
        // Users who haven't completed onboarding get the welcome flow instead
        if (!user.onboarded) {
          msgLog.info(`User ${slackUserId} not onboarded — sending welcome DM`);
          try {
            await sendWelcomeDm(client, slackUserId);
            // If this was in a channel (not DM), nudge them
            if (channelType !== 'im') {
              await say({
                text: "Hey! Looks like you haven't set up your profile yet. Check your DMs — I just sent you a welcome message to get started!",
                thread_ts: threadTs,
              });
            }
          } catch (err) {
            msgLog.error(`Failed to send onboarding DM to ${slackUserId}: ${err}`);
          }
          return;
        }

        // Check if there's an active conversation in this thread
        let conversation = getConversationByThread(channelId, threadTs);
        if (!conversation) {
          conversation = startConversation(user.id, channelId, threadTs, 'charla');
        }

        // Load thread history from DB for multi-turn context
        const maxHistory = getSetting('thread.max_history_messages', 20);
        const history: LlmMessage[] = getMessages(conversation.id, maxHistory);

        // Compute memory context once (used by both voice and text paths)
        const memoryContext = getMemoryForPrompt(user.id);

        // ── Voice memo path ──────────────────────────────────
        if (audioFile) {
          const audioUrl = audioFile.url_private ?? '';
          const botToken = process.env.SLACK_BOT_TOKEN ?? '';

          msgLog.info(`Processing voice memo from ${slackUserId} (${audioFile.mimetype}, ${audioFile.size} bytes)${text ? ` with text: "${text.slice(0, 80)}"` : ''}`);

          const result = await processVoiceMemo(
            audioUrl,
            botToken,
            history,
            user.level,
            text || undefined,
            memoryContext,
            user.id,
            user.displayName ?? undefined,
          );

          addTurn(conversation.id);
          updateStreak(user.id);
          const voiceXpResult = addXp(user.id, getXpForVoiceMemo());

          // Save messages to DB for thread continuity
          saveMessage(conversation.id, 'user', result.transcript.transcript);
          saveMessage(conversation.id, 'assistant', result.response.text);

          // Reply with transcript + response
          const blocks = formatVoiceResponseBlocks(result);
          await postMessage(
            client,
            channelId,
            result.response.text,
            blocks as any[],
            threadTs,
          );

          // Upload pronunciation demo clips if the LLM generated any
          await uploadPronunciationClips(result.response, client, channelId, threadTs);

          // Celebrate level-up
          if (voiceXpResult.leveledUp) {
            const updatedUser = getOrCreateUser(slackUserId);
            await postMessage(client, channelId, `🎉 *Level up!* You're now level ${updatedUser.level}. Keep it up!`, undefined, threadTs);
          }

          msgLog.info(`Voice memo processed for ${slackUserId}`);
          return;
        }

        // ── Text message path ────────────────────────────────

        const response = await processCharlaMessage(text, history, user.level, memoryContext, user.id, user.displayName ?? undefined);

        addTurn(conversation.id);
        updateStreak(user.id);
        const textXpResult = addXp(user.id, getXpForTextMessage());

        // Save messages to DB for thread continuity
        saveMessage(conversation.id, 'user', text);
        saveMessage(conversation.id, 'assistant', response.text);

        await say({
          text: response.text,
          thread_ts: threadTs,
        });

        // Upload pronunciation demo clips if the LLM generated any
        await uploadPronunciationClips(response, client, channelId, threadTs);

        // Celebrate level-up
        if (textXpResult.leveledUp) {
          const updatedUser = getOrCreateUser(slackUserId);
          await say({
            text: `🎉 *Level up!* You're now level ${updatedUser.level}. Keep it up!`,
            thread_ts: threadTs,
          });
        }

        // Regenerate memory profile periodically
        const memoryRegenInterval = getSetting('memory.regenerate_after_interactions', 20);
        const currentMemory = getMemory(user.id);
        const interactionsSinceMemory = user.xp - (currentMemory?.interactionCountAtGeneration ?? 0);
        if (!currentMemory || interactionsSinceMemory >= memoryRegenInterval) {
          generateMemory(user.id).catch((err) => {
            msgLog.error(`Memory generation failed: ${err}`);
          });
        }

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

  msgLog.info('Message and voice handlers registered');
}
