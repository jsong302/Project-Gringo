/**
 * Onboarding Handler — Welcomes new users with a DM flow.
 *
 * Entry points:
 *  - `team_join` event — fires when a user joins the workspace
 *  - `member_joined_channel` event — fires when a user joins a Gringo channel
 *  - Manual trigger via `/gringo onboard` — re-sends the welcome DM
 *
 * Flow:
 *  1. Welcome message + self-assessment buttons
 *  2. "No Spanish" → skip test, place at unit 1
 *  3. Others → placement test (multiple choice buttons)
 *  4. Placement result → response mode preference → voice tutorial → channel guide → "/gringo next"
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { getOrCreateUser, updateLevel, markOnboarded, updateDisplayName, updateResponseMode } from '../services/userService';
import type { ResponseMode } from '../services/userService';
import { postMessage } from '../utils/slackHelpers';
import {
  buildWelcomeBlocks,
  buildSelfAssessmentBlocks,
  buildPlacementSkipBlocks,
  buildPlacementStartBlocks,
  buildResponseModeBlocks,
  buildVoiceTutorialBlocks,
  buildChannelGuideBlocks,
} from '../services/onboarding';
import {
  startPlacementTest,
  processAnswer,
  getActiveTest,
  clearActiveTest,
  finalizePlacement,
  formatQuestionBlocks,
  formatPlacementResultBlocks,
  formatGapReviewBlocks,
} from '../services/placementTest';
import { initializeUserProgress } from '../services/curriculumDelivery';

const onboardLog = log.withScope('onboarding');

// Track users who've already been sent a welcome DM to prevent duplicates
const welcomeSent = new Set<string>();

// ── Slack profile lookup ────────────────────────────────────

/**
 * Fetch a user's display name from the Slack API.
 * Returns the real name or display name, or null if lookup fails.
 */
export async function fetchSlackDisplayName(client: any, slackUserId: string): Promise<string | null> {
  try {
    const info = await client.users.info({ user: slackUserId });
    const profile = info.user?.profile;
    return profile?.display_name || profile?.real_name || info.user?.real_name || null;
  } catch (err) {
    onboardLog.debug(`Could not fetch Slack profile for ${slackUserId}: ${err}`);
    return null;
  }
}

// ── Send the full welcome flow via DM ──────────────────────

/**
 * Opens a DM with the user and sends the onboarding messages.
 * Steps 1-2 are sent immediately; the rest depends on self-assessment.
 */
export async function sendWelcomeDm(client: any, slackUserId: string): Promise<void> {
  // Open a DM channel
  const dm = await client.conversations.open({ users: slackUserId });
  const channelId = dm.channel?.id;
  if (!channelId) {
    onboardLog.error(`Could not open DM with ${slackUserId}`);
    return;
  }

  // Fetch and store the user's display name from Slack
  const displayName = await fetchSlackDisplayName(client, slackUserId);
  const user = getOrCreateUser(slackUserId, displayName ?? undefined);
  if (displayName && !user.displayName) {
    updateDisplayName(user.id, displayName);
  }

  // Step 1: Welcome (personalized with name)
  const welcomeBlocks = buildWelcomeBlocks(displayName ?? undefined);
  await postMessage(client, channelId, 'Welcome to Gringo!', welcomeBlocks);

  // Step 2: Self-assessment buttons
  const assessBlocks = buildSelfAssessmentBlocks();
  await postMessage(client, channelId, 'How much Spanish do you know?', assessBlocks);

  onboardLog.info(`Welcome DM sent to ${slackUserId}${displayName ? ` (${displayName})` : ''}`);
}

/**
 * After placement, ask the user their response mode preference.
 */
async function sendResponseModePicker(client: any, channelId: string): Promise<void> {
  const blocks = buildResponseModeBlocks();
  await postMessage(client, channelId, 'How would you like feedback?', blocks);
}

/**
 * Sends the final onboarding messages (voice tutorial, channel guide, go prompt).
 */
async function sendFinalOnboardingDm(client: any, channelId: string): Promise<void> {
  const voiceBlocks = buildVoiceTutorialBlocks();
  await postMessage(client, channelId, 'Voice memo tutorial', voiceBlocks);

  const guideBlocks = buildChannelGuideBlocks();
  await postMessage(client, channelId, 'Channel guide', guideBlocks);

  await postMessage(client, channelId, "You're all set! Use `/gringo next` to start your first curriculum lesson whenever you're ready. Dale!");
}

// ── Registration ───────────────────────────────────────────

export function registerOnboardingHandlers(app: App): void {
  // Listen for new workspace members
  app.event('team_join', async ({ event, client }) => {
    const slackUserId = (event as any).user?.id ?? (event as any).user;
    if (!slackUserId) return;

    onboardLog.info(`New team member: ${slackUserId}`);

    try {
      const user = getOrCreateUser(slackUserId);
      if (user.onboarded || welcomeSent.has(slackUserId)) {
        onboardLog.debug(`User ${slackUserId} already onboarded or DM sent, skipping`);
        return;
      }
      welcomeSent.add(slackUserId);
      await sendWelcomeDm(client, slackUserId);
    } catch (err) {
      onboardLog.error(`Failed to onboard ${slackUserId}: ${err}`);
    }
  });

  // Listen for users joining a channel the bot is in
  app.event('member_joined_channel', async ({ event, client }) => {
    const slackUserId = (event as any).user;
    if (!slackUserId) return;

    try {
      const user = getOrCreateUser(slackUserId);
      if (user.onboarded || welcomeSent.has(slackUserId)) return;

      onboardLog.info(`User ${slackUserId} joined channel — sending onboarding DM`);
      welcomeSent.add(slackUserId);
      await sendWelcomeDm(client, slackUserId);
    } catch (err) {
      onboardLog.error(`Channel-join onboard failed for ${slackUserId}: ${err}`);
    }
  });

  // ── Self-assessment button handlers ──────────────────────

  // "No Spanish" → skip placement test, place at unit 1
  app.action('onboard_assess_1', async ({ ack, body, client }) => {
    await ack();
    const slackUserId = body.user.id;
    const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;

    onboardLog.info(`User ${slackUserId} selected "No Spanish" — skipping placement test`);

    try {
      const user = getOrCreateUser(slackUserId);
      updateLevel(user.id, 1);
      initializeUserProgress(user.id, 1);
      markOnboarded(user.id);
      welcomeSent.delete(slackUserId);

      if (channelId) {
        const skipBlocks = buildPlacementSkipBlocks();
        await postMessage(client, channelId, 'Placed at Unit 1', skipBlocks);
        await sendResponseModePicker(client, channelId);
      }
    } catch (err) {
      onboardLog.error(`Failed to handle no-spanish for ${slackUserId}: ${err}`);
    }
  });

  // "Some basics" / "Conversational" / "Advanced" → start placement test
  for (let claimed = 2; claimed <= 4; claimed++) {
    app.action(`onboard_assess_${claimed}`, async ({ ack, body, client }) => {
      await ack();
      const slackUserId = body.user.id;
      const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;

      const labels: Record<number, string> = { 2: 'Some basics', 3: 'Conversational', 4: 'Advanced' };
      onboardLog.info(`User ${slackUserId} selected "${labels[claimed]}" — starting placement test`);

      try {
        const user = getOrCreateUser(slackUserId);
        const state = startPlacementTest(user.id, slackUserId, claimed);

        if (channelId) {
          const startBlocks = buildPlacementStartBlocks();
          await postMessage(client, channelId, 'Starting placement test', startBlocks);

          // Send first question
          const firstQ = state.questionPool[0];
          const qBlocks = formatQuestionBlocks(firstQ, 1, state.questionPool.length);
          await postMessage(client, channelId, `Question 1/${state.questionPool.length}`, qBlocks);
        }
      } catch (err) {
        onboardLog.error(`Failed to start placement test for ${slackUserId}: ${err}`);
      }
    });
  }

  // ── Placement test answer handlers ────────────────────────

  for (let idx = 0; idx < 4; idx++) {
    app.action(`placement_answer_${idx}`, async ({ ack, body, client }) => {
      await ack();
      const slackUserId = body.user.id;
      const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;

      try {
        const result = processAnswer(slackUserId, idx);
        if (!result) {
          onboardLog.debug(`No active test for ${slackUserId} or test already complete`);
          return;
        }

        if (!channelId) return;

        const emoji = result.correct ? ':white_check_mark:' : ':x:';
        await postMessage(client, channelId, `${emoji} ${result.correct ? 'Correct!' : 'Not quite.'}`);

        if (result.testComplete) {
          const { totalCorrect, totalQuestions } = result;

          if (result.hasGaps) {
            // Gaps detected — show review and let user choose
            const gapBlocks = formatGapReviewBlocks(
              result.failedLevels,
              result.placedAtUnit,
              result.derivedLevel,
              result.skipAheadUnit,
              result.skipAheadLevel,
              totalCorrect,
              totalQuestions,
            );
            await postMessage(client, channelId, 'Placement complete — review your results', gapBlocks);
            // Don't finalize yet — wait for button choice
          } else {
            // No gaps — show result and finalize
            const resultBlocks = formatPlacementResultBlocks(
              result.placedAtUnit,
              result.derivedLevel,
              totalCorrect,
              totalQuestions,
            );
            await postMessage(client, channelId, 'Placement complete!', resultBlocks);

            const user = getOrCreateUser(slackUserId);
            markOnboarded(user.id);
            welcomeSent.delete(slackUserId);
            clearActiveTest(slackUserId);

            await sendResponseModePicker(client, channelId);
          }
        } else if (result.nextQuestion) {
          // Send next question
          const test = getActiveTest(slackUserId);
          const qNum = test ? test.currentQuestionIndex + 1 : 0;
          const total = test ? test.questionPool.length : 0;
          const qBlocks = formatQuestionBlocks(result.nextQuestion, qNum, total);
          await postMessage(client, channelId, `Question ${qNum}/${total}`, qBlocks);
        }
      } catch (err) {
        onboardLog.error(`Placement answer error for ${slackUserId}: ${err}`);
      }
    });
  }

  // ── Gap resolution button handlers ──────────────────────────

  for (const action of ['placement_fill_gaps', 'placement_skip_ahead'] as const) {
    app.action(action, async ({ ack, body, client }) => {
      await ack();
      const slackUserId = body.user.id;
      const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;

      try {
        const value = JSON.parse((body as any).actions?.[0]?.value ?? '{}');
        const unitOrder = value.unitOrder ?? 1;
        const level = value.level ?? 1;

        finalizePlacement(slackUserId, unitOrder, level);

        const user = getOrCreateUser(slackUserId);
        markOnboarded(user.id);
        welcomeSent.delete(slackUserId);

        const choice = action === 'placement_fill_gaps' ? 'fill the gaps' : 'skip ahead';
        onboardLog.info(`User ${slackUserId} chose to ${choice}: unit ${unitOrder}, level ${level}`);

        if (channelId) {
          const label = action === 'placement_fill_gaps'
            ? `You'll start at *Unit ${unitOrder}* (Level ${level}) to build a solid foundation. You'll move through the basics quickly!`
            : `You'll start at *Unit ${unitOrder}* (Level ${level}). If you hit a wall, you can always go back with \`/gringo next\`.`;
          await postMessage(client, channelId, label);
          await sendResponseModePicker(client, channelId);
        }
      } catch (err) {
        onboardLog.error(`Gap resolution failed for ${slackUserId}: ${err}`);
      }
    });
  }

  // ── Response mode preference handlers ──────────────────────

  for (const mode of ['text', 'voice'] as ResponseMode[]) {
    app.action(`onboard_response_${mode}`, async ({ ack, body, client }) => {
      await ack();
      const slackUserId = body.user.id;
      const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;

      try {
        const user = getOrCreateUser(slackUserId);
        updateResponseMode(user.id, mode);

        const label = mode === 'voice' ? 'voice memos' : 'text + pronunciation';
        onboardLog.info(`User ${slackUserId} chose response mode: ${mode}`);

        if (channelId) {
          await postMessage(client, channelId, `Got it — I'll give you feedback as *${label}*. You can change this anytime by telling me.`);
          await sendFinalOnboardingDm(client, channelId);
        }
      } catch (err) {
        onboardLog.error(`Response mode handler failed for ${slackUserId}: ${err}`);
      }
    });
  }

  onboardLog.info('Onboarding handlers registered');
}

// ── Manual trigger (from /gringo onboard) ──────────────────

export async function handleOnboardCommand(
  slackUserId: string,
  client: any,
  respond: (msg: any) => Promise<void>,
): Promise<void> {
  try {
    await sendWelcomeDm(client, slackUserId);
    await respond({
      response_type: 'ephemeral',
      text: 'Sent you a welcome DM. Check your direct messages!',
    });
  } catch (err) {
    onboardLog.error(`Manual onboard failed for ${slackUserId}: ${err}`);
    await respond({
      response_type: 'ephemeral',
      text: 'Could not send you a DM. Make sure DMs are enabled.',
    });
  }
}
