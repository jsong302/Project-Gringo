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
import { getOrCreateUser, updateLevel, XP_THRESHOLDS } from '../services/userService';
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

  cmdLog.info('Slash commands registered');
}
