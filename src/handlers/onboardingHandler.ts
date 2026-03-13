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
import { getOrCreateUser, updateLevel, markOnboarded } from '../services/userService';
import { postMessage } from '../utils/slackHelpers';
import {
  buildWelcomeBlocks,
  buildLevelPickerBlocks,
  buildLevelConfirmationBlocks,
  buildVoiceTutorialBlocks,
  buildChannelGuideBlocks,
  buildFirstExerciseBlocks,
} from '../services/onboarding';

const onboardLog = log.withScope('onboarding');

// ── Send the full welcome flow via DM ──────────────────────

/**
 * Opens a DM with the user and sends the onboarding messages.
 * Steps 1-2 are sent immediately; steps 3-4 are sent after
 * the user picks a level (via button action).
 */
async function sendWelcomeDm(client: any, slackUserId: string): Promise<void> {
  // Open a DM channel
  const dm = await client.conversations.open({ users: slackUserId });
  const channelId = dm.channel?.id;
  if (!channelId) {
    onboardLog.error(`Could not open DM with ${slackUserId}`);
    return;
  }

  // Step 1: Welcome
  const welcomeBlocks = buildWelcomeBlocks();
  await postMessage(client, channelId, 'Bienvenido a Gringo!', welcomeBlocks);

  // Step 2: Level picker
  const levelBlocks = buildLevelPickerBlocks();
  await postMessage(client, channelId, 'Elegí tu nivel', levelBlocks);

  onboardLog.info(`Welcome DM sent to ${slackUserId}`);
}

/**
 * Sends the post-level-selection messages (steps 3-4).
 */
async function sendPostLevelDm(client: any, channelId: string, level: number): Promise<void> {
  // Step 3: Level confirmation + voice tutorial
  const confirmBlocks = buildLevelConfirmationBlocks(level);
  await postMessage(client, channelId, `Nivel ${level} configurado`, confirmBlocks);

  const voiceBlocks = buildVoiceTutorialBlocks();
  await postMessage(client, channelId, 'Tutorial de audio', voiceBlocks);

  // Step 4: Channel guide + first exercise
  const guideBlocks = buildChannelGuideBlocks();
  await postMessage(client, channelId, 'Guía de canales', guideBlocks);

  const exerciseBlocks = buildFirstExerciseBlocks(level);
  await postMessage(client, channelId, 'Tu primer ejercicio', exerciseBlocks);
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
      if (user.onboarded) {
        onboardLog.debug(`User ${slackUserId} already onboarded, skipping`);
        return;
      }
      await sendWelcomeDm(client, slackUserId);
    } catch (err) {
      onboardLog.error(`Failed to onboard ${slackUserId}: ${err}`);
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
      text: 'Te mandé un DM con la guía de bienvenida. Revisá tus mensajes directos!',
    });
  } catch (err) {
    onboardLog.error(`Manual onboard failed for ${slackUserId}: ${err}`);
    await respond({
      response_type: 'ephemeral',
      text: 'No pude mandarte el DM. Asegurate de tener los DMs habilitados.',
    });
  }
}
