import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { toGringoError } from '../errors/gringoError';
import { formatUserFacingError } from '../errors/formatUserFacingError';
import { runWithObservabilityContext, getTraceId } from '../observability/context';
import { respondEphemeral, buildHelpBlocks, postMessage } from '../utils/slackHelpers';
import { handleRepaso, ensureUser, registerReviewActions } from './reviewHandler';
import { registerMessageHandlers } from './messageHandler';
import { handleAdmin } from './adminHandler';
import { registerOnboardingHandlers, handleOnboardCommand } from './onboardingHandler';
import { handleDesafio, registerDesafioActions } from './desafioHandler';
import {
  getOrCreateUser,
  updateLevel,
  updateTimezone,
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from '../services/userService';
import { getUserCardStats } from '../services/srsRepository';
import { getErrorSummary } from '../services/errorTracker';
import { getLearnerFacts } from '../services/learnerFacts';
import { getMemory } from '../services/userMemory';
import { getUserPlan, formatPlanBlocks, generatePlan, hasPlan } from '../services/lessonPlan';
import {
  getCurrentUnit,
  getUserCurriculumProgress,
  generateUnitLesson,
  generateUnitExercise,
  markUnitPracticing,
  activateNextUnit,
  formatLessonBlocks,
  formatExerciseBlocks,
  trackUnitMessage,
  clearTrackedMessages,
} from '../services/curriculumDelivery';
import { getCurriculumCount } from '../services/curriculum';

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
        // Gate commands behind onboarding (except help, onboard, level)
        const UNGATED_COMMANDS = ['help', '', 'onboard', 'level', 'timezone'];
        if (!UNGATED_COMMANDS.includes(subcommand)) {
          const user = getOrCreateUser(command.user_id);
          if (!user.onboarded) {
            await handleOnboardCommand(command.user_id, client, respond);
            return;
          }
        }

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
              await respondEphemeral(respond, `Your level: *${user.level}/5*\nUse \`/gringo level <1-5>\` to change it.`);
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

          case 'timezone': {
            const tzArgs = command.text.trim().split(/\s+/).slice(1);
            const user = getOrCreateUser(command.user_id);

            if (tzArgs.length > 0) {
              const tz = tzArgs[0];
              // Validate timezone by trying to use it
              try {
                new Date().toLocaleTimeString('en-GB', { timeZone: tz });
              } catch {
                await respondEphemeral(respond, `Invalid timezone: "${tz}". Use IANA format, e.g. \`America/New_York\`, \`Europe/London\`, \`America/Argentina/Buenos_Aires\``);
                break;
              }
              updateTimezone(user.id, tz);
              await respondEphemeral(respond, `Timezone updated to *${tz}*. Notifications and quiet hours will use this timezone.`);
            } else {
              await respondEphemeral(respond, `Your timezone: *${user.timezone}*\nUse \`/gringo timezone <IANA timezone>\` to change it.\nExamples: \`America/New_York\`, \`America/Chicago\`, \`America/Los_Angeles\`, \`America/Argentina/Buenos_Aires\``);
            }
            break;
          }

          case 'profile': {
            const user = getOrCreateUser(command.user_id);
            const facts = getLearnerFacts(user.id, 15);
            const cardStats = getUserCardStats(user.id);
            const errorSummary = getErrorSummary(user.id);

            const sections: string[] = [
              `*Name:* ${user.displayName ?? 'Unknown'}`,
              `*Level:* ${user.level}/5 | *Streak:* ${user.streakDays} day${user.streakDays !== 1 ? 's' : ''}`,
              `*Timezone:* ${user.timezone}`,
              `*SRS Cards:* ${cardStats.total} (${cardStats.due} due)`,
            ];

            if (errorSummary.length > 0) {
              sections.push(`\n*Error Patterns:*`);
              for (const e of errorSummary) {
                sections.push(`• ${e.category}: ${e.count}`);
              }
            }

            if (facts.length > 0) {
              sections.push(`\n*What I've noticed about you:*`);
              for (const f of facts.slice(0, 10)) {
                const icon = f.category === 'strength' ? '💪' : f.category === 'interest' ? '🎯' : f.category === 'error_pattern' ? '📝' : f.category === 'pronunciation' ? '🗣️' : '•';
                sections.push(`${icon} ${f.fact}`);
              }
            }

            const memory = getMemory(user.id);
            if (memory) {
              sections.push(`\n*Learner Profile:*`);
              sections.push(memory.profileSummary);
              if (memory.strengths) sections.push(`*Strengths:* ${memory.strengths}`);
              if (memory.weaknesses) sections.push(`*Areas to improve:* ${memory.weaknesses}`);
              if (memory.interests) sections.push(`*Interests:* ${memory.interests}`);
              if (memory.pronunciationNotes) sections.push(`*Pronunciation:* ${memory.pronunciationNotes}`);
            }

            if (!facts.length && !memory) {
              sections.push(`\n_I haven't built a profile for you yet — keep chatting and I'll learn your strengths and areas to improve!_`);
            }

            const blocks = [
              { type: 'header', text: { type: 'plain_text', text: 'Your Profile' } },
              { type: 'section', text: { type: 'mrkdwn', text: sections.join('\n') } },
            ];

            await respondEphemeral(respond, 'Your Profile', blocks as any);
            break;
          }

          case 'plan': {
            const user = getOrCreateUser(command.user_id);
            let plan = getUserPlan(user.id);

            if (plan.length === 0) {
              await respondEphemeral(respond, 'Generating your lesson plan...');
              plan = await generatePlan(user.id, user.level);
            }

            const planBlocks = formatPlanBlocks(plan);
            await respondEphemeral(respond, 'Your Lesson Plan', planBlocks as any);
            break;
          }

          case 'next': {
            const user = getOrCreateUser(command.user_id);

            // Open a DM channel for lesson delivery
            const dm = await client.conversations.open({ users: command.user_id });
            const dmChannel = dm.channel?.id;
            if (!dmChannel) {
              await respondEphemeral(respond, 'Could not open a DM with you. Make sure DMs are enabled.');
              break;
            }

            let current = getCurrentUnit(user.id);

            // If current unit is passed or no active unit, try to activate next
            if (!current || current.progress.status === 'passed') {
              const nextUnit = activateNextUnit(user.id);
              if (!nextUnit) {
                await respondEphemeral(respond, "You've completed all available curriculum units! Check back later for new content.");
                break;
              }
              current = getCurrentUnit(user.id);
            }

            if (!current) {
              await respondEphemeral(respond, 'No curriculum units available. Ask an admin to check the curriculum.');
              break;
            }

            await respondEphemeral(respond, 'Delivering your next lesson via DM...');

            // Clear any previously tracked messages for this user (stale from prior unit)
            const oldMsgs = clearTrackedMessages(user.id);
            for (const msgTs of oldMsgs) {
              try {
                await client.chat.delete({ channel: dmChannel, ts: msgTs });
              } catch {
                // ignore — message may already be deleted
              }
            }

            const totalUnits = getCurriculumCount();

            // Generate and send lesson
            const lessonText = await generateUnitLesson(current.unit, user.id);
            const lessonBlocks = formatLessonBlocks(current.unit, lessonText, totalUnits);
            const lessonTs = await postMessage(client, dmChannel, `Unit ${current.unit.unitOrder}: ${current.unit.title}`, lessonBlocks as any[]);
            trackUnitMessage(user.id, lessonTs);

            // Generate and send exercise
            const exerciseText = await generateUnitExercise(current.unit, user.id);
            const exerciseBlocks = formatExerciseBlocks(exerciseText);
            const exerciseTs = await postMessage(client, dmChannel, 'Exercise', exerciseBlocks as any[]);
            trackUnitMessage(user.id, exerciseTs);

            // Mark unit as practicing
            markUnitPracticing(user.id, current.unit.id);

            break;
          }

          case 'progress': {
            const user = getOrCreateUser(command.user_id);
            const progress = getUserCurriculumProgress(user.id);

            const pct = progress.totalCount > 0
              ? Math.round((progress.completedCount / progress.totalCount) * 100)
              : 0;

            const blocks = [
              {
                type: 'header',
                text: { type: 'plain_text', text: 'Your Curriculum Progress' },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    `*Level:* ${progress.level}`,
                    `*Completed:* ${progress.completedCount}/${progress.totalCount} units (${pct}%)`,
                    progress.currentUnit
                      ? `*Current Unit:* ${progress.currentUnit.unitOrder} — ${progress.currentUnit.title}`
                      : '*Current Unit:* None active',
                    '',
                    '_Use `/gringo next` to continue your lessons._',
                  ].join('\n'),
                },
              },
            ];

            await respondEphemeral(respond, 'Curriculum Progress', blocks as any);
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
