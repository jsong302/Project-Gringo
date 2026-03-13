/**
 * Onboarding Handler — Welcomes new users with a DM flow.
 *
 * Entry points:
 *  - `team_join` event — fires when a user joins the workspace
 *  - `member_joined_channel` event — fires when a user joins a Gringo channel
 *    (catches users who were already in the workspace but just joined the channel)
 *  - Manual trigger via `/gringo onboard` — re-sends the welcome DM
 *
 * The flow sends a series of DMs: welcome → level picker buttons →
 * voice tutorial → channel guide + first exercise.
 *
 * Level picker buttons trigger `onboard_level_N` actions that set the
 * user's level and continue the flow.
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { getOrCreateUser, updateLevel, markOnboarded, updateDisplayName } from '../services/userService';
import { postMessage } from '../utils/slackHelpers';
import {
  buildWelcomeBlocks,
  buildLevelPickerBlocks,
  buildLevelConfirmationBlocks,
  buildVoiceTutorialBlocks,
  buildChannelGuideBlocks,
  buildFirstExerciseBlocks,
} from '../services/onboarding';
import { generatePlan } from '../services/lessonPlan';

const onboardLog = log.withScope('onboarding');

// Track users who've already been sent a welcome DM to prevent duplicates
// (e.g. user joins multiple channels before completing onboarding)
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
 * Steps 1-2 are sent immediately; steps 3-4 are sent after
 * the user picks a level (via button action).
 *
 * Also fetches the user's Slack display name and stores it.
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

  // Step 2: Level picker
  const levelBlocks = buildLevelPickerBlocks();
  await postMessage(client, channelId, 'Pick your level', levelBlocks);

  onboardLog.info(`Welcome DM sent to ${slackUserId}${displayName ? ` (${displayName})` : ''}`);
}

/**
 * Sends the post-level-selection messages (steps 3-4).
 */
async function sendPostLevelDm(client: any, channelId: string, level: number): Promise<void> {
  // Step 3: Level confirmation + voice tutorial
  const confirmBlocks = buildLevelConfirmationBlocks(level);
  await postMessage(client, channelId, `Level ${level} set`, confirmBlocks);

  const voiceBlocks = buildVoiceTutorialBlocks();
  await postMessage(client, channelId, 'Voice memo tutorial', voiceBlocks);

  // Step 4: Channel guide + first exercise
  const guideBlocks = buildChannelGuideBlocks();
  await postMessage(client, channelId, 'Channel guide', guideBlocks);

  const exerciseBlocks = buildFirstExerciseBlocks(level);
  await postMessage(client, channelId, 'Your first exercise', exerciseBlocks);

  // Step 5: Completion confirmation
  await postMessage(client, channelId, "You're all set! Head to any channel and start practicing. Dale! 🇦🇷");
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

  // Level picker button actions (onboard_level_1 through onboard_level_5)
  for (let level = 1; level <= 5; level++) {
    app.action(`onboard_level_${level}`, async ({ ack, body, client }) => {
      await ack();

      const slackUserId = body.user.id;
      const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;

      onboardLog.info(`User ${slackUserId} selected level ${level}`);

      try {
        const user = getOrCreateUser(slackUserId);
        updateLevel(user.id, level);
        markOnboarded(user.id);
        welcomeSent.delete(slackUserId);

        // Generate personalized lesson plan in the background
        generatePlan(user.id, level).catch((err) => {
          onboardLog.error(`Failed to generate lesson plan for ${slackUserId}: ${err}`);
        });

        if (channelId) {
          await sendPostLevelDm(client, channelId, level);
        }
      } catch (err) {
        onboardLog.error(`Failed to set level for ${slackUserId}: ${err}`);
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
