/**
 * Desafio (Pair Practice) Handler
 *
 * Manages a queue for matching users who want to practice dialogue.
 * Supports both random matching and direct challenges.
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { runWithObservabilityContext } from '../observability/context';
import { callLlm } from '../services/llm';
import { getPromptOrThrow, interpolate } from '../services/prompts';
import { parseLlmJson } from '../services/lessonEngine';
import { getOrCreateUser } from '../services/userService';
import { startConversation } from '../services/conversationTracker';

const desafioLog = log.withScope('desafio');

const QUEUE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── In-memory queue ──────────────────────────────────────────

interface QueueEntry {
  userId: string;
  channelId: string;
  enqueuedAt: number;
}

/** Users waiting for a random match. */
const waitingQueue: QueueEntry[] = [];

/** Pending direct challenges: challengerId -> targetId */
interface DirectChallenge {
  challengerId: string;
  targetId: string;
  createdAt: number;
}

const directChallenges = new Map<string, DirectChallenge>();

// ── Helpers ──────────────────────────────────────────────────

function pruneExpired(): void {
  const now = Date.now();
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (now - waitingQueue[i].enqueuedAt > QUEUE_TIMEOUT_MS) {
      desafioLog.debug(`Queue entry expired for user ${waitingQueue[i].userId}`);
      waitingQueue.splice(i, 1);
    }
  }
  for (const [key, challenge] of directChallenges) {
    if (now - challenge.createdAt > QUEUE_TIMEOUT_MS) {
      desafioLog.debug(`Direct challenge expired: ${key}`);
      directChallenges.delete(key);
    }
  }
}

function removeFromQueue(userId: string): void {
  const idx = waitingQueue.findIndex((e) => e.userId === userId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function parseUserMention(text: string): string | null {
  // Slack user mentions look like <@U12345> or <@U12345|name>
  const match = text.match(/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/);
  return match ? match[1] : null;
}

// ── Scenario generation ─────────────────────────────────────

interface DesafioScenario {
  title: string;
  setting: string;
  role_a: string;
  role_b: string;
  vocab_hints: string[];
  opening_line: string;
}

async function generateScenario(levelA: number, levelB: number): Promise<DesafioScenario | null> {
  try {
    const template = getPromptOrThrow('desafio_scenario');
    const prompt = interpolate(template, {
      level_a: String(levelA),
      level_b: String(levelB),
    });

    const response = await callLlm({
      system: 'Respond only with valid JSON. No additional text.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
    });

    return parseLlmJson<DesafioScenario>(response.text);
  } catch (err) {
    desafioLog.error(`Scenario generation failed: ${err}`);
    return null;
  }
}

function formatScenarioBlocks(scenario: DesafioScenario, role: 'a' | 'b', partnerId: string): any[] {
  const myRole = role === 'a' ? scenario.role_a : scenario.role_b;
  const vocabList = scenario.vocab_hints.map((v) => `• ${v}`).join('\n');

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎭 Desafío: ${scenario.title}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Setting:* ${scenario.setting}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Your role:* ${myRole}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Useful vocab:*\n${vocabList}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: role === 'a'
          ? `*Start with:* _"${scenario.opening_line}"_\n\nSend it to <@${partnerId}> to begin!`
          : `Wait for <@${partnerId}> to start the conversation!`,
      },
    },
  ];
}

// ── Main handler ─────────────────────────────────────────────

export async function handleDesafio(
  userId: string,
  channelId: string,
  text: string,
  respond: (msg: any) => Promise<unknown>,
  client: any,
): Promise<void> {
  pruneExpired();

  const args = text.replace(/^desafio\s*/i, '').trim();
  const targetUser = parseUserMention(args);

  if (targetUser) {
    await handleDirectChallenge(userId, targetUser, respond, client);
  } else {
    await handleQueueMatch(userId, channelId, respond, client);
  }
}

// ── Random queue matching ────────────────────────────────────

async function handleQueueMatch(
  userId: string,
  channelId: string,
  respond: (msg: any) => Promise<unknown>,
  client: any,
): Promise<void> {
  // Check if user is already in queue
  if (waitingQueue.some((e) => e.userId === userId)) {
    await respond({
      response_type: 'ephemeral',
      text: 'You are already in the queue waiting for a partner. Hang tight!',
    });
    return;
  }

  // Try to find a match
  const match = waitingQueue.find((e) => e.userId !== userId);

  if (match) {
    // Found a match — remove from queue and notify both
    removeFromQueue(match.userId);
    desafioLog.info(`Desafio match: ${userId} <-> ${match.userId}`);

    await respond({
      response_type: 'ephemeral',
      text: `Match found! You've been paired with <@${match.userId}> for dialogue practice. Check your DMs!`,
    });

    // Generate a scenario for the pair
    const userA = getOrCreateUser(userId);
    const userB = getOrCreateUser(match.userId);
    const scenario = await generateScenario(userA.level, userB.level);

    // DM both users with scenario
    try {
      const dm1 = await client.conversations.open({ users: userId });
      const ch1 = dm1.channel?.id;
      if (ch1) {
        if (scenario) {
          await client.chat.postMessage({
            channel: ch1,
            text: `Desafío: ${scenario.title} — You're matched with <@${match.userId}>!`,
            blocks: formatScenarioBlocks(scenario, 'a', match.userId),
          });
          // Create a conversation thread for tracking
          startConversation(userA.id, ch1, '', 'desafio', JSON.stringify(scenario));
        } else {
          await client.chat.postMessage({
            channel: ch1,
            text: `You've been matched with <@${match.userId}> for dialogue practice! Start a conversation and practice your Argentine Spanish together.`,
          });
        }
      }
    } catch (err) {
      desafioLog.error(`Failed to DM user ${userId}: ${err}`);
    }

    try {
      const dm2 = await client.conversations.open({ users: match.userId });
      const ch2 = dm2.channel?.id;
      if (ch2) {
        if (scenario) {
          await client.chat.postMessage({
            channel: ch2,
            text: `Desafío: ${scenario.title} — You're matched with <@${userId}>!`,
            blocks: formatScenarioBlocks(scenario, 'b', userId),
          });
          startConversation(userB.id, ch2, '', 'desafio', JSON.stringify(scenario));
        } else {
          await client.chat.postMessage({
            channel: ch2,
            text: `You've been matched with <@${userId}> for dialogue practice! Start a conversation and practice your Argentine Spanish together.`,
          });
        }
      }
    } catch (err) {
      desafioLog.error(`Failed to DM user ${match.userId}: ${err}`);
    }
  } else {
    // No match — add to queue
    waitingQueue.push({ userId, channelId, enqueuedAt: Date.now() });
    desafioLog.info(`User ${userId} added to desafio queue (queue size: ${waitingQueue.length})`);

    await respond({
      response_type: 'ephemeral',
      text: 'Looking for a partner... You\'ll be notified when someone else joins. (Timeout in 10 min)',
    });
  }
}

// ── Direct challenge ─────────────────────────────────────────

async function handleDirectChallenge(
  challengerId: string,
  targetId: string,
  respond: (msg: any) => Promise<unknown>,
  client: any,
): Promise<void> {
  if (challengerId === targetId) {
    await respond({
      response_type: 'ephemeral',
      text: 'You can\'t challenge yourself! Try `/gringo desafio` to find a random partner.',
    });
    return;
  }

  const challengeKey = `${challengerId}_${targetId}`;
  directChallenges.set(challengeKey, {
    challengerId,
    targetId,
    createdAt: Date.now(),
  });

  desafioLog.info(`Direct challenge: ${challengerId} -> ${targetId}`);

  await respond({
    response_type: 'ephemeral',
    text: `Challenge sent to <@${targetId}>! They'll receive a DM to accept or decline.`,
  });

  // DM the target with Accept/Decline buttons
  try {
    const dm = await client.conversations.open({ users: targetId });
    const dmCh = dm.channel?.id;
    if (!dmCh) throw new Error('Could not open DM channel');
    await client.chat.postMessage({
      channel: dmCh,
      text: `<@${challengerId}> has challenged you to a dialogue practice session!`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `<@${challengerId}> has challenged you to a dialogue practice session! Do you accept?`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Accept' },
              action_id: 'desafio_accept',
              value: challengeKey,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Decline' },
              action_id: 'desafio_decline',
              value: challengeKey,
              style: 'danger',
            },
          ],
        },
      ],
    });
  } catch (err) {
    desafioLog.error(`Failed to DM challenge to ${targetId}: ${err}`);
    await respond({
      response_type: 'ephemeral',
      text: `Couldn't send the challenge DM to <@${targetId}>. They may have DMs disabled.`,
    });
  }
}

// ── Action handlers ──────────────────────────────────────────

export function registerDesafioActions(app: App): void {
  app.action('desafio_accept', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        const actionBody = body as any;
        const challengeKey = actionBody.actions?.[0]?.value as string;
        const challenge = directChallenges.get(challengeKey);

        if (!challenge) {
          // Challenge expired or already handled
          const dm = await client.conversations.open({ users: body.user.id });
          const ch = dm.channel?.id;
          if (ch) await client.chat.postMessage({ channel: ch, text: 'This challenge has expired or was already handled.' });
          return;
        }

        directChallenges.delete(challengeKey);
        desafioLog.info(`Challenge accepted: ${challenge.challengerId} <-> ${challenge.targetId}`);

        // Generate scenario
        const challenger = getOrCreateUser(challenge.challengerId);
        const target = getOrCreateUser(challenge.targetId);
        const scenario = await generateScenario(challenger.level, target.level);

        // Notify both users via DM with scenario
        try {
          const dm1 = await client.conversations.open({ users: challenge.challengerId });
          const ch1 = dm1.channel?.id;
          if (ch1) {
            if (scenario) {
              await client.chat.postMessage({
                channel: ch1,
                text: `Desafío: ${scenario.title} — Challenge accepted by <@${challenge.targetId}>!`,
                blocks: formatScenarioBlocks(scenario, 'a', challenge.targetId),
              });
              startConversation(challenger.id, ch1, '', 'desafio', JSON.stringify(scenario));
            } else {
              await client.chat.postMessage({
                channel: ch1,
                text: `Challenge accepted! You and <@${challenge.targetId}> are matched for dialogue practice.`,
              });
            }
          }
        } catch (err) {
          desafioLog.error(`Failed to DM challenger ${challenge.challengerId}: ${err}`);
        }

        try {
          const dm2 = await client.conversations.open({ users: challenge.targetId });
          const ch2 = dm2.channel?.id;
          if (ch2) {
            if (scenario) {
              await client.chat.postMessage({
                channel: ch2,
                text: `Desafío: ${scenario.title} — You accepted <@${challenge.challengerId}>'s challenge!`,
                blocks: formatScenarioBlocks(scenario, 'b', challenge.challengerId),
              });
              startConversation(target.id, ch2, '', 'desafio', JSON.stringify(scenario));
            } else {
              await client.chat.postMessage({
                channel: ch2,
                text: `Challenge accepted! You and <@${challenge.challengerId}> are matched for dialogue practice.`,
              });
            }
          }
        } catch (err) {
          desafioLog.error(`Failed to DM target ${challenge.targetId}: ${err}`);
        }

        // Update the original message to show accepted
        if (actionBody.message && actionBody.channel) {
          try {
            await client.chat.update({
              channel: actionBody.channel.id,
              ts: actionBody.message.ts,
              text: `You accepted the challenge from <@${challenge.challengerId}>!`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `You accepted the challenge from <@${challenge.challengerId}>! Check your DMs for details.`,
                  },
                },
              ],
            });
          } catch {
            // Best effort update
          }
        }
      } catch (err) {
        desafioLog.error(`desafio_accept failed: ${err}`);
      }
    });
  });

  app.action('desafio_decline', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        const actionBody = body as any;
        const challengeKey = actionBody.actions?.[0]?.value as string;
        const challenge = directChallenges.get(challengeKey);

        if (!challenge) {
          const dm = await client.conversations.open({ users: body.user.id });
          const ch = dm.channel?.id;
          if (ch) await client.chat.postMessage({ channel: ch, text: 'This challenge has expired or was already handled.' });
          return;
        }

        directChallenges.delete(challengeKey);
        desafioLog.info(`Challenge declined: ${challenge.challengerId} -> ${challenge.targetId}`);

        // Notify challenger
        try {
          const dm = await client.conversations.open({ users: challenge.challengerId });
          const chDm = dm.channel?.id;
          if (chDm) {
            await client.chat.postMessage({
              channel: chDm,
              text: `<@${challenge.targetId}> declined your dialogue practice challenge. Try \`/gringo desafio\` to find a random partner!`,
            });
          }
        } catch (err) {
          desafioLog.error(`Failed to DM challenger ${challenge.challengerId}: ${err}`);
        }

        // Update the original message to show declined
        if (actionBody.message && actionBody.channel) {
          try {
            await client.chat.update({
              channel: actionBody.channel.id,
              ts: actionBody.message.ts,
              text: `You declined the challenge from <@${challenge.challengerId}>.`,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `You declined the challenge from <@${challenge.challengerId}>.`,
                  },
                },
              ],
            });
          } catch {
            // Best effort update
          }
        }
      } catch (err) {
        desafioLog.error(`desafio_decline failed: ${err}`);
      }
    });
  });

  desafioLog.info('Desafio action handlers registered');
}
