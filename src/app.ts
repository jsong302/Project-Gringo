import 'dotenv/config';

import { App } from '@slack/bolt';
import { loadConfig, printConfigSnapshot } from './config/env';
import { initDb, closeDb } from './db';
import { registerCommands } from './handlers/commands';
import { seedDefaultSettings, getAdminUserIds, setSetting, getSetting } from './services/settings';
import { seedDefaultPrompts } from './services/prompts';
import { seedAllContent } from './services/seedContent';
import { createDefaultJobs, scheduleJobs, stopAllJobs } from './scheduler/cron';
import { initLlm } from './services/llm';
import { initTts } from './services/tts';
import { initStt } from './services/stt';
import { generateDailyLesson, generateLunfardoPost, logLesson, createCardsFromLesson, createCardsFromLunfardo } from './services/lessonEngine';
import { getAllUsers } from './services/userService';
import { recoverSessions } from './services/reviewSession';
import { recoverHomeSessions } from './services/homeSession';
import { sendSrsReminders, sendLessonNotifications, sendOnboardingFollowUp } from './services/notifications';
import { closeStaleConversations } from './services/conversationTracker';
import { log } from './utils/logger';
import { seedCurriculumIfEmpty } from './services/curriculum';
import { migrateExistingUsers } from './services/curriculumMigration';

const bootLog = log.withScope('boot');

(async () => {
  // 1. Load and validate config
  const config = loadConfig();
  printConfigSnapshot(config);

  // 2. Initialize database
  await initDb(config.db);

  // 3. Initialize LLM client
  if (config.anthropic) {
    initLlm(config.anthropic);
  }

  // 3b. Initialize STT (Deepgram)
  if (config.deepgram) {
    initStt(config.deepgram);
  }

  // 3c. Initialize TTS (Azure Speech)
  if (config.azure) {
    initTts(config.azure.speechKey, config.azure.speechRegion);
  }

  // 4. Seed default settings, prompts & content
  seedDefaultSettings();
  seedDefaultPrompts();
  seedAllContent();

  // 4b. Seed shared curriculum and migrate existing users
  seedCurriculumIfEmpty();
  migrateExistingUsers();

  // 4c. Recover active review sessions from DB
  recoverSessions();

  // 4d. Recover home tab sessions from DB
  recoverHomeSessions();

  // 5. Bootstrap admins from env
  if (config.app.adminUserIds.length > 0) {
    const current = getAdminUserIds();
    const merged = [...new Set([...current, ...config.app.adminUserIds])];
    if (merged.length !== current.length) {
      setSetting('admin.user_ids', merged, 'Slack user IDs with admin access (JSON array)', 'bootstrap');
      bootLog.info(`Bootstrapped admin user IDs from env: ${config.app.adminUserIds.join(', ')}`);
    }
  }

  // 6. Create Slack Bolt app with Socket Mode
  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  // 7. Register handlers
  registerCommands(app);

  // 8. Start cron scheduler
  const jobs = createDefaultJobs({
    postDailyLesson: async () => {
      try {
        const users = getAllUsers();
        const avgLevel = users.length > 0
          ? Math.round(users.reduce((sum, u) => sum + u.level, 0) / users.length)
          : 2;
        const { lesson, blocks } = await generateDailyLesson(avgLevel);
        const channelId = getSetting('channels.lessons', '');
        if (!channelId) {
          bootLog.warn('No channels.lessons setting configured — skipping daily lesson post');
          return;
        }
        const postResult = await app.client.chat.postMessage({ channel: channelId, text: lesson.title, blocks });
        const messageTs = postResult.ts ?? '';
        logLesson({ lessonType: 'daily', topic: lesson.title, contentJson: JSON.stringify(lesson), slackChannelId: channelId, slackMessageTs: messageTs });

        // Auto-create SRS cards from lesson vocabulary for active users
        const activeUserIds = users.map((u) => u.id);
        createCardsFromLesson(lesson, activeUserIds);

        // Notify users via DM
        sendLessonNotifications(app.client, channelId, lesson.title).catch((err) => {
          bootLog.error(`Lesson notifications failed: ${err}`);
        });

        bootLog.info('Daily lesson posted');
      } catch (err) {
        bootLog.error(`Daily lesson job failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    postLunfardoDelDia: async () => {
      try {
        const { post, blocks } = await generateLunfardoPost();
        const channelId = getSetting('channels.lunfardo', '');
        if (!channelId) {
          bootLog.warn('No channels.lunfardo setting configured — skipping lunfardo post');
          return;
        }
        await app.client.chat.postMessage({ channel: channelId, text: 'Lunfardo del día: ' + post.word, blocks });
        logLesson({ lessonType: 'lunfardo', topic: post.word, contentJson: JSON.stringify(post), slackChannelId: channelId });

        // Auto-create SRS cards from lunfardo word for all users
        const lunfardoUsers = getAllUsers();
        if (lunfardoUsers.length > 0) {
          createCardsFromLunfardo(post, lunfardoUsers.map((u) => u.id));
        }

        bootLog.info('Lunfardo del día posted');
      } catch (err) {
        bootLog.error(`Lunfardo job failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    sendSrsReminders: async () => {
      try {
        await sendSrsReminders(app.client);
      } catch (err) {
        bootLog.error(`SRS reminders failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    closeStaleThreads: async () => {
      try {
        closeStaleConversations(24);
      } catch (err) {
        bootLog.error(`Stale thread cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    sendOnboardingFollowUp: async () => {
      try {
        await sendOnboardingFollowUp(app.client);
      } catch (err) {
        bootLog.error(`Onboarding follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  scheduleJobs(jobs);

  // 9. Graceful shutdown
  const shutdown = async (signal: string) => {
    bootLog.info(`${signal} received — shutting down`);
    stopAllJobs();
    closeDb();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 10. Start
  await app.start();
  bootLog.info('Gringo bot is running. Dale que va!');
})().catch((err) => {
  bootLog.error(`Fatal error during startup: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    bootLog.error(err.stack);
  }
  process.exit(1);
});
