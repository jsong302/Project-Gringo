import type { RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

export async function respondEphemeral(
  respond: RespondFn,
  text: string,
  blocks?: Record<string, unknown>[],
): Promise<void> {
  await respond({
    response_type: 'ephemeral',
    text,
    ...(blocks ? { blocks } : {}),
  });
}

export async function postMessage(
  client: WebClient,
  channel: string,
  text: string,
  blocks?: Record<string, unknown>[],
  threadTs?: string,
): Promise<void> {
  await client.chat.postMessage({
    channel,
    text,
    ...(blocks ? { blocks } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

export function buildHelpBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Welcome to Gringo — Your Argentine Spanish Tutor',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Gringo teaches you Rioplatense Spanish — with voseo, lunfardo, and real Argentine flavor. Here\'s everything you need to know:',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Channels*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`#daily-lesson` — Daily lesson: vocab, grammar, culture, and a voice exercise (Mon-Fri)',
          '`#charla-libre` — Free conversation with the bot in Argentine Spanish',
          '`#lunfardo-del-dia` — A new lunfardo (slang) word every day with etymology',
          '`#repaso` — Spaced repetition review sessions (SRS flashcards)',
          '`#desafios` — Pair practice with dialogue scenarios',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Commands*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`/gringo help` — This guide',
          '`/gringo level` — View or change your level (1-5)',
          '`/gringo stats` — Your streak, words learned, and progress',
          '`/gringo repaso` — Start a review session',
          '`/gringo onboard` — Re-send the welcome DM',
          '`/gringo admin <message>` — Admin agent (admins only)',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Check your level with `/gringo level`. Let\'s go!',
        },
      ],
    },
  ];
}
