/**
 * App Home Tab Handler — renders the Gringo dashboard when users click the app.
 *
 * Shows: profile, curriculum progress, current exercise status, stats, quick actions.
 * Refreshes on every `app_home_opened` event.
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { runWithObservabilityContext } from '../observability/context';
import { getOrCreateUser } from '../services/userService';
import { getUserCardStats } from '../services/srsRepository';
import { getErrorSummary } from '../services/errorTracker';
import { getCurrentUnit, getUserCurriculumProgress } from '../services/curriculumDelivery';
import { getCurriculumCount } from '../services/curriculum';
import { getMemory } from '../services/userMemory';

const homeLog = log.withScope('home-tab');

function buildProgressBar(completed: number, total: number, width: number = 20): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((completed / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildHomeBlocks(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const cardStats = getUserCardStats(user.id);
  const progress = getUserCurriculumProgress(user.id);
  const current = getCurrentUnit(user.id);
  const errorSummary = getErrorSummary(user.id);
  const memory = getMemory(user.id);
  const totalUnits = getCurriculumCount();

  const pct = totalUnits > 0
    ? Math.round((progress.completedCount / totalUnits) * 100)
    : 0;

  const blocks: Record<string, unknown>[] = [];

  // ── Header ──────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':argentina: Gringo — Your Argentine Spanish Tutor' },
  });

  // ── Profile ─────────────────────────────────────────────
  const responseLabel = user.responseMode === 'voice' ? 'Voice' : 'Text';
  const streakEmoji = user.streakDays >= 7 ? ' :fire:' : '';
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*:bust_in_silhouette: Profile*`,
        `*Name:* ${user.displayName ?? 'Unknown'}`,
        `*Level:* ${progress.level}/5  |  *Streak:* ${user.streakDays} day${user.streakDays !== 1 ? 's' : ''}${streakEmoji}`,
        `*Feedback:* ${responseLabel}  |  *Timezone:* ${user.timezone}`,
      ].join('\n'),
    },
  });

  blocks.push({ type: 'divider' });

  // ── Curriculum Progress ─────────────────────────────────
  const bar = buildProgressBar(progress.completedCount, totalUnits);
  const progressLines = [
    `*:books: Curriculum Progress*   Unit ${progress.completedCount} of ${totalUnits}`,
    `\`${bar}\`  ${pct}%`,
  ];

  // Show recent/current/upcoming units
  if (current) {
    const unitOrder = current.unit.unitOrder;
    // Show previous unit if exists
    if (unitOrder > 1) {
      progressLines.push(`  :white_check_mark: Unit ${unitOrder - 1} — _completed_`);
    }
    const statusLabel = current.progress.status === 'practicing'
      ? ':arrow_forward: practicing'
      : ':arrow_forward: active';
    progressLines.push(`  ${statusLabel} *Unit ${unitOrder} — ${current.unit.title}*`);
    if (unitOrder < totalUnits) {
      progressLines.push(`  :lock: Unit ${unitOrder + 1} — _locked_`);
    }
  } else if (progress.completedCount === totalUnits && totalUnits > 0) {
    progressLines.push('  :tada: *All units completed!*');
  } else {
    progressLines.push('  _No active unit — use `/gringo next` to start_');
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: progressLines.join('\n') },
  });

  // ── Current Exercise ────────────────────────────────────
  if (current && current.progress.status === 'practicing') {
    blocks.push({ type: 'divider' });

    const attemptLine = current.progress.attempts > 0
      ? `Attempts: ${current.progress.attempts}  |  Need: ${current.unit.passThreshold}/5 to pass`
      : `Need: ${current.unit.passThreshold}/5 to pass`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*:memo: Current Exercise*`,
          `Unit ${current.unit.unitOrder}: *${current.unit.title}*`,
          `${attemptLine}`,
          '',
          ':speech_balloon: _Reply in your DMs to answer_',
        ].join('\n'),
      },
    });
  }

  blocks.push({ type: 'divider' });

  // ── Stats ───────────────────────────────────────────────
  const errorLine = errorSummary.length > 0
    ? errorSummary.slice(0, 3).map((e) => `${e.category}: ${e.count}`).join(', ')
    : 'none yet';

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*:bar_chart: Stats*`,
        `*SRS Cards:* ${cardStats.total} (${cardStats.due} due)  |  *Units Passed:* ${progress.completedCount}`,
        `*Common errors:* ${errorLine}`,
      ].join('\n'),
    },
  });

  // ── Learner profile summary ─────────────────────────────
  if (memory && memory.profileSummary) {
    blocks.push({ type: 'divider' });
    const profileLines = [`*:brain: Learner Profile*`, memory.profileSummary];
    if (memory.strengths) profileLines.push(`*Strengths:* ${memory.strengths}`);
    if (memory.weaknesses) profileLines.push(`*Areas to improve:* ${memory.weaknesses}`);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: profileLines.join('\n') },
    });
  }

  blocks.push({ type: 'divider' });

  // ── Quick Actions ───────────────────────────────────────
  const actions: Record<string, unknown>[] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: ':arrow_right: Next Unit' },
      action_id: 'home_next_unit',
      style: 'primary',
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: ':recycle: Practice SRS' },
      action_id: 'home_practice_srs',
    },
  ];

  if (cardStats.due > 0) {
    actions[1] = {
      ...actions[1],
      text: { type: 'plain_text', text: `:recycle: Practice SRS (${cardStats.due} due)` },
    };
  }

  blocks.push({
    type: 'actions',
    elements: actions,
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_This dashboard updates each time you open the app._' }],
  });

  return blocks;
}

// ── Registration ────────────────────────────────────────────

export function registerHomeHandler(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    await runWithObservabilityContext(async () => {
      const slackUserId = event.user;

      // Only render the Home tab (not Messages tab)
      if ((event as any).tab !== 'home') return;

      try {
        const blocks = buildHomeBlocks(slackUserId);

        await client.views.publish({
          user_id: slackUserId,
          view: {
            type: 'home',
            blocks: blocks as any,
          },
        });

        homeLog.debug(`Home tab rendered for ${slackUserId}`);
      } catch (err) {
        homeLog.error(`Failed to render Home tab for ${slackUserId}: ${err}`);
      }
    });
  });

  // ── Quick Action: Next Unit ───────────────────────────────
  app.action('home_next_unit', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;

      try {
        // Open DM and send a hint — reuse the same /gringo next logic via DM
        const dm = await client.conversations.open({ users: slackUserId });
        const dmChannel = dm.channel?.id;
        if (!dmChannel) return;

        await client.chat.postMessage({
          channel: dmChannel,
          text: '_Loading your next unit..._\nTip: You can also use `/gringo next` anytime.',
        });

        // Trigger the /gringo next flow by importing the delivery functions
        const { activateNextUnit, generateUnitLesson, generateUnitExercise, formatLessonBlocks, formatExerciseBlocks, markUnitPracticing, trackUnitMessage, clearTrackedMessages } = await import('../services/curriculumDelivery');
        const { getCurriculumCount: getCount } = await import('../services/curriculum');
        const { postMessage } = await import('../utils/slackHelpers');
        const { getOrCreateUser: getUser } = await import('../services/userService');

        const user = getUser(slackUserId);
        let current = getCurrentUnit(user.id);

        if (!current || current.progress.status === 'passed') {
          const nextUnit = activateNextUnit(user.id);
          if (!nextUnit) {
            await client.chat.postMessage({
              channel: dmChannel,
              text: "You've completed all available curriculum units! Check back later for new content.",
            });
            return;
          }
          current = getCurrentUnit(user.id);
        }

        if (!current) {
          await client.chat.postMessage({
            channel: dmChannel,
            text: 'No curriculum units available. Ask an admin to check the curriculum.',
          });
          return;
        }

        // Clear old tracked messages
        const oldMsgs = clearTrackedMessages(user.id);
        for (const msgTs of oldMsgs) {
          try { await client.chat.delete({ channel: dmChannel, ts: msgTs }); } catch { /* ignore */ }
        }

        const total = getCount();
        const lessonText = await generateUnitLesson(current.unit, user.id);
        const lessonBlocks = formatLessonBlocks(current.unit, lessonText, total);
        const lessonTs = await postMessage(client, dmChannel, `Unit ${current.unit.unitOrder}: ${current.unit.title}`, lessonBlocks as any[]);
        trackUnitMessage(user.id, lessonTs);

        const exerciseText = await generateUnitExercise(current.unit, user.id);
        const exerciseBlocks = formatExerciseBlocks(exerciseText);
        const exerciseTs = await postMessage(client, dmChannel, 'Exercise', exerciseBlocks as any[]);
        trackUnitMessage(user.id, exerciseTs);

        markUnitPracticing(user.id, current.unit.id);

        // Refresh Home tab
        const blocks = buildHomeBlocks(slackUserId);
        await client.views.publish({
          user_id: slackUserId,
          view: { type: 'home', blocks: blocks as any },
        });
      } catch (err) {
        homeLog.error(`Home next-unit action failed: ${err}`);
      }
    });
  });

  // ── Quick Action: Practice SRS ────────────────────────────
  app.action('home_practice_srs', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;

      try {
        const dm = await client.conversations.open({ users: slackUserId });
        const dmChannel = dm.channel?.id;
        if (!dmChannel) return;

        await client.chat.postMessage({
          channel: dmChannel,
          text: '_Starting your SRS review..._\nTip: You can also use `/gringo repaso` anytime.',
        });

        const { ensureUser, handleRepaso } = await import('./reviewHandler');
        const userId = ensureUser(slackUserId);

        // Use a simple respond wrapper that posts to DM
        const respond = async (msg: any) => {
          const text = typeof msg === 'string' ? msg : (msg.text ?? '');
          const blocks = typeof msg === 'object' ? msg.blocks : undefined;
          await client.chat.postMessage({
            channel: dmChannel!,
            text,
            blocks,
          });
        };

        await handleRepaso(userId, dmChannel, respond);
      } catch (err) {
        homeLog.error(`Home practice-srs action failed: ${err}`);
      }
    });
  });

  homeLog.info('Home tab handler registered');
}
