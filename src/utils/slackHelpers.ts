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
          '`#lunfardo-del-dia` — A new lunfardo (slang) word every day with etymology',
          '`#desafios` — Pair practice with dialogue scenarios',
          '',
          '_DM me anytime for free conversation practice or to run `/gringo repaso` for SRS flashcards!_',
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
          '`/gringo profile` — See what the bot knows about you',
          '`/gringo plan` — View your personalized lesson plan',
          '`/gringo repaso` — Start a review session',
          '`/gringo onboard` — Re-send the welcome DM',
          '`/gringo notifications` — Manage notification preferences',
          '`/gringo timezone` — Set your timezone for notifications',
          '`/gringo desafio` — Find a partner for dialogue practice',
          '`/gringo desafio @user` — Challenge someone directly',
          '`/gringo admin <message>` — Admin agent (admins only)',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Voice Memos*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Send voice memos to practice speaking and get pronunciation feedback!',
          '',
          '*Desktop:* Click the *+* button in the message field → *Record audio clip*',
          '*Mobile:* Tap and hold the microphone icon in the message field',
          '',
          'Send a voice memo with the text "check my pronunciation" to get detailed feedback on your accent, grammar, and word choice.',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Tips*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Say *"no entiendo"* or *"help"* during a conversation and I\'ll explain my last message in English.',
          '',
          '*Reply to daily lessons* in the thread to get your answer graded — text or voice memos both work!',
          '',
          'The bot builds a learner profile as you practice. Use `/gringo profile` to see what it knows about you.',
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
