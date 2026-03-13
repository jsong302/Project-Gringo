import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { toGringoError } from '../errors/gringoError';
import { formatUserFacingError } from '../errors/formatUserFacingError';
import { runWithObservabilityContext, getTraceId } from '../observability/context';
import { respondEphemeral, buildHelpBlocks } from '../utils/slackHelpers';
import { handleRepaso, ensureUser, registerReviewActions } from './reviewHandler';
import { registerMessageHandlers } from './messageHandler';
import { handleAdmin } from './adminHandler';
import { registerOnboardingHandlers, handleOnboardCommand } from './onboardingHandler';
import { handleDesafio, registerDesafioActions } from './desafioHandler';
import {
  getOrCreateUser,
  updateLevel,
  XP_THRESHOLDS,
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from '../services/userService';
import { getUserCardStats } from '../services/srsRepository';
import { getErrorSummary } from '../services/errorTracker';

const cmdLog = log.withScope('commands');

export function registerCommands(app: App): void {
  app.command('/gringo', async ({ command, ack, respond, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const traceId = getTraceId();
      const subcommand = command.text.trim().split(/\s+/)[0]?.toLowerCase() || 'help';

      cmdLog.info(`/gringo ${subcommand}`, {
        user: command.user_id,
        channel: command.channel_id,
        trace_id: traceId,
      });

      try {
        switch (subcommand) {
          case 'help':
          case '': {
            const blocks = buildHelpBlocks();
            await respondEphemeral(respond, 'Gringo Help', blocks);
            break;
          }

          case 'repaso': {
            const userId = ensureUser(command.user_id);
            await handleRepaso(userId, command.channel_id, respond);
            break;
          }

          case 'level': {
            const args = command.text.trim().split(/\s+/).slice(1);
            const user = getOrCreateUser(command.user_id);

            if (args.length > 0) {
              const newLevel = parseInt(args[0], 10);
              if (isNaN(newLevel) || newLevel < 1 || newLevel > 5) {
                await respondEphemeral(respond, 'Level must be between 1 and 5. Example: `/gringo level 3`');
                break;
              }
              updateLevel(user.id, newLevel);
              await respondEphemeral(respond, `Level updated to *${newLevel}*. Lessons and reviews will adapt.`);
            } else {
              const threshold = XP_THRESHOLDS[user.level] ?? Infinity;
              const progress = threshold === Infinity ? 'max' : `${user.xp}/${threshold} XP`;
              await respondEphemeral(respond, `Your level: *${user.level}/5* (${progress})\nUse \`/gringo level <1-5>\` to change it.`);
            }
            break;
          }

          case 'stats': {
            const user = getOrCreateUser(command.user_id);
            const cardStats = getUserCardStats(user.id);
            const errorSummary = getErrorSummary(user.id);

            const errorLine = errorSummary.length > 0
              ? errorSummary.map((e) => `${e.category}: ${e.count}`).join(', ')
              : 'none yet';

            const blocks = [
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Your Stats' },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    `*Level:* ${user.level}/5`,
                    `*XP:* ${user.xp}`,
                    `*Streak:* ${user.streakDays} day${user.streakDays !== 1 ? 's' : ''}`,
                    '',
                    `*SRS Cards:* ${cardStats.total} total`,
                    `• Due today: ${cardStats.due}`,
                    `• Learning: ${cardStats.learning}`,
                    `• Reviewing: ${cardStats.reviewing}`,
                    '',
                    `*Common errors:* ${errorLine}`,
                  ].join('\n'),
                },
              },
            ];

            await respondEphemeral(respond, 'Your Stats', blocks as any);
            break;
          }

          case 'admin': {
            const adminMessage = command.text.trim().slice('admin'.length).trim();
            await handleAdmin(command.user_id, adminMessage, respond);
            break;
          }

          case 'onboard': {
            await handleOnboardCommand(command.user_id, client, respond);
            break;
          }

          case 'desafio': {
            await handleDesafio(command.user_id, command.channel_id, command.text, respond, client);
            break;
          }

          case 'notifications': {
            const user = getOrCreateUser(command.user_id);
            const notifArgs = command.text.trim().split(/\s+/).slice(1);
            const prefs = getNotificationPrefs(user.id);

            if (notifArgs[0] === 'quiet' && notifArgs.length >= 3) {
              const start = notifArgs[1];
              const end = notifArgs[2];
              const timeRe = /^\d{1,2}:\d{2}$/;
              if (!timeRe.test(start) || !timeRe.test(end)) {
                await respondEphemeral(respond, 'Invalid time format. Use HH:MM, e.g. `/gringo notifications quiet 22:00 08:00`');
                break;
              }
              prefs.quietStart = start;
              prefs.quietEnd = end;
              setNotificationPrefs(user.id, prefs);
              await respondEphemeral(respond, `Quiet hours set: ${start} - ${end}`, buildNotificationBlocks(prefs));
            } else {
              const blocks = buildNotificationBlocks(prefs);
              await respondEphemeral(respond, 'Notification Settings', blocks);
            }
            break;
          }

          default:
            await respondEphemeral(
              respond,
              `Unknown command. Try \`/gringo help\` to see available commands.`,
            );
            break;
        }
      } catch (err) {
        const gringoErr = toGringoError(err, 'ERR_UNKNOWN');
        gringoErr.trace_id = traceId;
        cmdLog.error(`Command failed: ${gringoErr.message}`, {
          code: gringoErr.code,
          trace_id: traceId,
        });
        await respondEphemeral(respond, formatUserFacingError(gringoErr));
      }
    });
  });

  // Register interactive button handlers for SRS review
  registerReviewActions(app);

  // Register onboarding handlers (team_join + level picker buttons)
  registerOnboardingHandlers(app);

  // Register message and voice memo handlers
  registerMessageHandlers(app);

  // Register desafio (pair practice) action handlers
  registerDesafioActions(app);

  // Register notification preference action handlers
  registerNotificationActions(app);

  cmdLog.info('Slash commands registered');
}

// ── Notification Settings ───────────────────────────────────

function buildNotificationBlocks(prefs: NotificationPrefs): Record<string, unknown>[] {
  const srsLabel = prefs.srsReminders ? 'SRS Reminders: ON' : 'SRS Reminders: OFF';
  const lessonsLabel = prefs.dailyLessons ? 'Daily Lessons: ON' : 'Daily Lessons: OFF';
  const quietLabel = prefs.quietStart && prefs.quietEnd
    ? `Quiet Hours: ${prefs.quietStart} - ${prefs.quietEnd}`
    : 'Quiet Hours: not set';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Notification Settings' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*SRS Reminders:* ${prefs.srsReminders ? 'ON' : 'OFF'}`,
          `*Daily Lessons:* ${prefs.dailyLessons ? 'ON' : 'OFF'}`,
          `*${quietLabel}*`,
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: srsLabel },
          action_id: 'notif_toggle_srs',
          style: prefs.srsReminders ? 'primary' : 'danger',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: lessonsLabel },
          action_id: 'notif_toggle_lessons',
          style: prefs.dailyLessons ? 'primary' : 'danger',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Set Quiet Hours' },
          action_id: 'notif_quiet_hours',
        },
      ],
    },
  ];
}

function registerNotificationActions(app: App): void {
  app.action('notif_toggle_srs', async ({ ack, body, respond }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        const slackUserId = body.user.id;
        const user = getOrCreateUser(slackUserId);
        const prefs = getNotificationPrefs(user.id);
        prefs.srsReminders = !prefs.srsReminders;
        setNotificationPrefs(user.id, prefs);

        const blocks = buildNotificationBlocks(prefs);
        await respond({
          response_type: 'ephemeral',
          text: `SRS Reminders ${prefs.srsReminders ? 'enabled' : 'disabled'}.`,
          blocks: blocks as any,
        });
      } catch (err) {
        cmdLog.error(`notif_toggle_srs failed: ${err}`);
        await respond({ response_type: 'ephemeral', text: 'Error updating notification settings.' });
      }
    });
  });

  app.action('notif_toggle_lessons', async ({ ack, body, respond }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        const slackUserId = body.user.id;
        const user = getOrCreateUser(slackUserId);
        const prefs = getNotificationPrefs(user.id);
        prefs.dailyLessons = !prefs.dailyLessons;
        setNotificationPrefs(user.id, prefs);

        const blocks = buildNotificationBlocks(prefs);
        await respond({
          response_type: 'ephemeral',
          text: `Daily Lessons ${prefs.dailyLessons ? 'enabled' : 'disabled'}.`,
          blocks: blocks as any,
        });
      } catch (err) {
        cmdLog.error(`notif_toggle_lessons failed: ${err}`);
        await respond({ response_type: 'ephemeral', text: 'Error updating notification settings.' });
      }
    });
  });

  app.action('notif_quiet_hours', async ({ ack, body, respond }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        const slackUserId = body.user.id;
        const args = ((body as any).message?.text ?? '').trim();

        // If there's no input yet, ask the user for times
        await respond({
          response_type: 'ephemeral',
          text: 'To set quiet hours, use: `/gringo notifications quiet <start> <end>`\nExample: `/gringo notifications quiet 22:00 08:00`',
        });
      } catch (err) {
        cmdLog.error(`notif_quiet_hours failed: ${err}`);
        await respond({ response_type: 'ephemeral', text: 'Error updating quiet hours.' });
      }
    });
  });

  cmdLog.info('Notification action handlers registered');
}
