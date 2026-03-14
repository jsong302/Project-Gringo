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
import { updateStreak } from '../services/userService';
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
import { getSetting } from '../services/settings';
import { sendWelcomeDm } from './onboardingHandler';
import { generatePronunciationAudio, generateCorrectionAudio } from '../services/pronunciation';
import { uploadAudioToSlack } from '../utils/slackAudio';
import { getActiveTest } from '../services/placementTest';
import {
  getCurrentUnit,
  gradeExerciseResponse,
  markUnitPassed,
  recordAttempt,
  activateNextUnit,
  formatGradeBlocks as formatCurriculumGradeBlocks,
  trackUnitMessage,
  clearTrackedMessages,
} from '../services/curriculumDelivery';
import { getHomeSession, setHomeSession, createDefaultSession, publishHomeTab } from '../services/homeSession';

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
 * Returns true for: DMs, @mentions, or messages in monitored channels (lessons, lunfardo).
 */
async function shouldRespond(
  text: string,
  channelType: string,
  channelId: string,
  client: any,
): Promise<boolean> {
  // Always respond in DMs
  if (channelType === 'im') return true;

  // Always respond in monitored lesson/lunfardo channels
  const lessonsChannel = getSetting('channels.lessons', '');
  const lunfardoChannel = getSetting('channels.lunfardo', '');
  if (channelId && (channelId === lessonsChannel || channelId === lunfardoChannel)) return true;

  // In other channels, only respond when @mentioned
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
  threadTs?: string,
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
    const messageTs = (message as any).ts as string;
    const threadTs = (message as any).thread_ts ?? messageTs;
    // In DMs, reply as top-level messages (natural conversation); in channels, use threads
    const replyTs = channelType === 'im' ? undefined : threadTs;
    const text = ((message as any).text ?? '') as string;
    const audioFile = getAudioFile(message);

    // Need either text or audio to respond
    if (!text && !audioFile) return;

    await runWithObservabilityContext(async () => {
      try {
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

              await postMessage(client, channelId, grading.responseEs || grading.praise, blocks as any[], threadTs);
              msgLog.info(`Graded lesson response from ${slackUserId}: ${grading.correct} (${grading.score}/5)`);
            }
            return;
          }
        }

        // Only respond in DMs, monitored channels, or when @mentioned
        if (!await shouldRespond(text, channelType, channelId, client)) return;

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
                thread_ts: replyTs,
              });
            }
          } catch (err) {
            msgLog.error(`Failed to send onboarding DM to ${slackUserId}: ${err}`);
          }
          return;
        }

        // ── Placement test gate ──────────────────────────────
        // If user is mid-placement test, ignore DM messages (test uses buttons)
        if (channelType === 'im' && getActiveTest(slackUserId)) {
          await say({ text: 'You have a placement test in progress! Please answer using the buttons above.' });
          return;
        }

        // ── Curriculum exercise grading ──────────────────────
        // If user has a unit in "practicing" status in DM, grade their response
        // The LLM grader detects non-exercise messages (questions, navigation) via isAttempt flag
        if (channelType === 'im' && (text || audioFile)) {
          const current = getCurrentUnit(user.id);
          if (current && current.progress.status === 'practicing') {
            // Transcribe voice memo if needed
            let responseText = text;
            let wordConfidence: import('../services/stt').WordInfo[] | undefined;
            if (audioFile && !text) {
              const { transcribeAudio } = await import('../services/stt');
              const audioUrl = audioFile.url_private ?? '';
              const botToken = process.env.SLACK_BOT_TOKEN ?? '';
              const transcript = await transcribeAudio(audioUrl, botToken);
              responseText = transcript.transcript;
              wordConfidence = transcript.words;
              msgLog.info(`Transcribed voice memo for exercise: "${responseText.slice(0, 80)}" (${transcript.words.length} words, avg confidence: ${transcript.words.length > 0 ? (transcript.words.reduce((s, w) => s + w.confidence, 0) / transcript.words.length * 100).toFixed(0) : 0}%)`);
            }

            if (!responseText) return;

            msgLog.info(`Grading curriculum exercise for ${slackUserId} (unit ${current.unit.unitOrder})`);

            // Get the exercise text from the unit
            const exerciseText = current.unit.exercisePrompt ?? current.unit.title;
            const exerciseInputMode = (audioFile && !text) ? 'voice' as const : 'text' as const;
            const grade = await gradeExerciseResponse(current.unit, exerciseText, responseText, user.id, exerciseInputMode, wordConfidence);

            // If the LLM determined this isn't an exercise attempt, fall through to charla
            if (!grade.isAttempt) {
              msgLog.info(`Non-exercise message detected by grader during practicing: "${(responseText ?? '').slice(0, 60)}"`);
              // Don't return — fall through to charla conversation handler below
            } else {
              // Check if the lesson is on the Home tab — if so, redirect grading there
              const homeState = getHomeSession(user.id);
              const isHomeTabLesson = homeState && (homeState.view === 'lesson' || homeState.view === 'grade');
              const isVoiceMemo = audioFile && !text;

              if (grade.passed) {
                const { leveledUp, newLevel } = markUnitPassed(user.id, current.unit.id, grade.score);
                updateStreak(user.id);

                if (isHomeTabLesson) {
                  // Grade results go to Home tab
                  const passState = homeState ?? createDefaultSession(user.id, slackUserId);
                  passState.view = 'grade';
                  passState.unit = current.unit;
                  passState.lastGradeResult = grade;
                  setHomeSession(passState);
                  await publishHomeTab(client, slackUserId);

                  // Brief DM confirmation pointing to Home tab
                  await say({ text: `:white_check_mark: *Passed!* (${grade.score}/5) — Check your Home tab for details.` });

                  // Send pronunciation audio in DM if there's a correction
                  if (grade.correction) {
                    try {
                      const audioBuffers = await generatePronunciationAudio([grade.correction]);
                      if (audioBuffers[0]) {
                        await uploadAudioToSlack(client, channelId, audioBuffers[0], grade.correction);
                      }
                    } catch { /* audio is best-effort */ }
                  }
                } else {
                  // Legacy DM-only flow
                  const oldMessages = clearTrackedMessages(user.id);
                  for (const msgTs of oldMessages) {
                    try {
                      await client.chat.delete({ channel: channelId, ts: msgTs });
                    } catch { /* Message may already be deleted */ }
                  }

                  const summaryText = leveledUp
                    ? `:white_check_mark: *Unit ${current.unit.unitOrder}: ${current.unit.title}* — Passed (${grade.score}/5)\n:arrow_up: *Leveled up to Level ${newLevel}!*`
                    : `:white_check_mark: *Unit ${current.unit.unitOrder}: ${current.unit.title}* — Passed (${grade.score}/5)`;

                  await say({
                    text: summaryText,
                    blocks: [
                      { type: 'section', text: { type: 'mrkdwn', text: summaryText } },
                      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Use `/gringo next` to continue to the next unit!_' }] },
                    ] as any,
                  });

                  // Also update Home tab
                  const passState = createDefaultSession(user.id, slackUserId);
                  passState.view = 'grade';
                  passState.unit = current.unit;
                  passState.lastGradeResult = grade;
                  setHomeSession(passState);
                  publishHomeTab(client, slackUserId).catch(() => {});
                }
                return;

              } else {
                const attempts = recordAttempt(user.id, current.unit.id, grade.score);
                updateStreak(user.id);

                if (isHomeTabLesson) {
                  // Grade results go to Home tab
                  const failState = homeState ?? createDefaultSession(user.id, slackUserId);
                  failState.view = 'grade';
                  failState.unit = current.unit;
                  failState.lastGradeResult = grade;
                  failState.exerciseText = failState.exerciseText ?? (current.unit.exercisePrompt ?? current.unit.title);
                  setHomeSession(failState);
                  await publishHomeTab(client, slackUserId);

                  // Brief DM notification pointing to Home tab
                  await say({ text: `:x: Score: ${grade.score}/5 — Check your Home tab for feedback and try again.` });

                  // Send audio correction in DM
                  if (grade.correction) {
                    try {
                      if (user.responseMode === 'voice') {
                        const audio = await generateCorrectionAudio(grade.feedback, grade.correction);
                        if (audio) {
                          await uploadAudioToSlack(client, channelId, audio, `Correction: ${grade.correction}`);
                        }
                      } else {
                        const audioBuffers = await generatePronunciationAudio([grade.correction]);
                        if (audioBuffers[0]) {
                          await uploadAudioToSlack(client, channelId, audioBuffers[0], grade.correction);
                        }
                      }
                    } catch { /* audio is best-effort */ }
                  }
                } else {
                  // Legacy DM-only flow
                  if (user.responseMode === 'voice') {
                    const emoji = ':x:';
                    const minimalText = `${emoji} Score: ${grade.score}/5 — need ${current.unit.passThreshold}+ to pass. Listen to the voice memo below for feedback.`;
                    const minimalResult = await say({ text: minimalText });
                    trackUnitMessage(user.id, (minimalResult as any)?.ts);

                    if (grade.correction) {
                      const audio = await generateCorrectionAudio(grade.feedback, grade.correction);
                      if (audio) {
                        await uploadAudioToSlack(client, channelId, audio, `Correction: ${grade.correction}`);
                      }
                    }
                  } else {
                    const blocks = formatCurriculumGradeBlocks(grade, current.unit, false);
                    const gradeResult = await say({ text: `Score: ${grade.score}`, blocks: blocks as any });
                    trackUnitMessage(user.id, (gradeResult as any)?.ts);

                    if (grade.correction) {
                      const audioBuffers = await generatePronunciationAudio([grade.correction]);
                      if (audioBuffers[0]) {
                        await uploadAudioToSlack(client, channelId, audioBuffers[0], grade.correction);
                      }
                    }
                  }

                  if (attempts >= 3) {
                    const hintResult = await say({ text: "_Hint: Try reviewing the lesson above and focus on the key vocabulary. You've got this!_" });
                    trackUnitMessage(user.id, (hintResult as any)?.ts);
                  }

                  // Also update Home tab
                  const failState = getHomeSession(user.id) ?? createDefaultSession(user.id, slackUserId);
                  failState.view = 'grade';
                  failState.unit = current.unit;
                  failState.lastGradeResult = grade;
                  setHomeSession(failState);
                  publishHomeTab(client, slackUserId).catch(() => {});
                }
                return;
              }
            }
            // If !grade.isAttempt, we fall through to charla below
          }
        }

        // Check if there's an active conversation
        // In DMs, use a stable key so all messages are one continuous conversation
        // In channels, use the thread timestamp to keep conversations separate
        const conversationKey = channelType === 'im' ? 'dm' : threadTs;
        let conversation = getConversationByThread(channelId, conversationKey);
        if (!conversation) {
          conversation = startConversation(user.id, channelId, conversationKey, 'charla');
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
            slackUserId,
          );

          addTurn(conversation.id);
          updateStreak(user.id);

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
            replyTs,
          );

          // Upload pronunciation demo clips if the LLM generated any
          await uploadPronunciationClips(result.response, client, channelId, replyTs);

          msgLog.info(`Voice memo processed for ${slackUserId}`);
          return;
        }

        // ── Text message path ────────────────────────────────

        const response = await processCharlaMessage(text, history, user.level, memoryContext, user.id, user.displayName ?? undefined, slackUserId);

        addTurn(conversation.id);
        updateStreak(user.id);

        // Save messages to DB for thread continuity
        saveMessage(conversation.id, 'user', text);
        saveMessage(conversation.id, 'assistant', response.text);

        await say({
          text: response.text,
          thread_ts: replyTs,
        });

        // Upload pronunciation demo clips if the LLM generated any
        await uploadPronunciationClips(response, client, channelId, replyTs);

        // Regenerate memory profile periodically based on conversation turns
        const memoryRegenInterval = getSetting('memory.regenerate_after_interactions', 20);
        const currentMemory = getMemory(user.id);
        const turnsSinceMemory = conversation.turnCount - (currentMemory?.interactionCountAtGeneration ?? 0);
        if (!currentMemory || turnsSinceMemory >= memoryRegenInterval) {
          generateMemory(user.id).catch((err) => {
            msgLog.error(`Memory generation failed: ${err}`);
          });
        }

        msgLog.debug(`Replied to ${slackUserId} in ${channelId}`);
      } catch (err: any) {
        msgLog.error(`Message handler failed: ${err}`);
        const userMessage = err?.userMessage
          ?? (err?.code === 'ERR_STT_FAILED' ? err.message : null)
          ?? 'Something went wrong. Please try again in a moment. If this keeps happening, contact Joshua Song.';
        await say({
          text: userMessage,
          thread_ts: replyTs,
        });
      }
    });
  });

  msgLog.info('Message and voice handlers registered');
}
