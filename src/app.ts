import 'dotenv/config';

import { App } from '@slack/bolt';
import { loadConfig, printConfigSnapshot } from './config/env';
import { initDb, closeDb } from './db';
import { registerCommands } from './handlers/commands';
import { seedDefaultSettings, getAdminUserIds, setSetting } from './services/settings';
import { seedDefaultPrompts } from './services/prompts';
import { seedAllContent } from './services/seedContent';
import { createDefaultJobs, scheduleJobs, stopAllJobs } from './scheduler/cron';
import { initLlm } from './services/llm';
import { log } from './utils/logger';

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

  // 4. Seed default settings, prompts & content
  seedDefaultSettings();
  seedDefaultPrompts();
  seedAllContent();

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
      bootLog.info('Daily lesson job triggered (handler not yet implemented)');
    },
    postLunfardoDelDia: async () => {
      bootLog.info('Lunfardo del día job triggered (handler not yet implemented)');
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
