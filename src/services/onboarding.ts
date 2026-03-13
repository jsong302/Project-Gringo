/**
 * Onboarding Service — Block Kit builders for the new-user welcome flow.
 *
 * Flow:
 *  1. Welcome message explaining Gringo
 *  2. Level assessment via buttons (1-5)
 *  3. Voice memo tutorial
 *  4. Channel guide + first exercise prompt
 *
 * Each step is a separate message so the user can scroll back.
 */

// ── Step 1: Welcome ────────────────────────────────────────

export function buildWelcomeBlocks(displayName?: string): Record<string, unknown>[] {
  const greeting = displayName
    ? `Hey ${displayName}! I'm *Gringo*, your Argentine Spanish tutor.`
    : "I'm *Gringo*, your Argentine Spanish tutor.";

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Welcome to Gringo!', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${greeting} I'll teach you to speak like a real porteño — with voseo, lunfardo, and authentic flavor.`,
          '',
          "There's a small group (6-15 people) learning together. We'll chat, practice with voice memos, and review vocabulary every day.",
          '',
          "First, I need to know your level so I can adapt the lessons. Pick the one that fits:",
        ].join('\n'),
      },
    },
  ];
}

// ── Step 2: Level Assessment ───────────────────────────────

export function buildLevelPickerBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What is your Spanish level?*',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '1 - None', emoji: true },
          action_id: 'onboard_level_1',
          value: '1',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '2 - A little', emoji: true },
          action_id: 'onboard_level_2',
          value: '2',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '3 - Intermediate', emoji: true },
          action_id: 'onboard_level_3',
          value: '3',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '4 - Advanced', emoji: true },
          action_id: 'onboard_level_4',
          value: '4',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '5 - Native/Fluent', emoji: true },
          action_id: 'onboard_level_5',
          value: '5',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_1 = never studied Spanish | 2 = know some basics | 3 = can hold a conversation | 4 = quite fluent | 5 = near native_',
        },
      ],
    },
  ];
}

// ── Step 3: Level Confirmation + Voice Tutorial ────────────

const LEVEL_DESCRIPTIONS: Record<number, string> = {
  1: 'Absolute beginner — we\'ll start from scratch, no worries.',
  2: 'Beginner — you know some basics, we\'ll build on that.',
  3: 'Intermediate — you can chat, now let\'s polish your skills.',
  4: 'Advanced — time to talk like a real porteño.',
  5: 'Expert — we\'ll fine-tune with lunfardo and slang.',
};

export function buildLevelConfirmationBlocks(level: number): Record<string, unknown>[] {
  const desc = LEVEL_DESCRIPTIONS[level] ?? '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Level ${level}* — ${desc}\n\nYou can change your level anytime with \`/gringo level <1-5>\`.`,
      },
    },
  ];
}

export function buildVoiceTutorialBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Key Feature: Voice Memos', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Practicing speaking is the most important part. Slack has built-in voice memos:',
          '',
          '*On desktop:*',
          '1. Click the *+* icon to the left of the message field',
          '2. Select *"Record audio clip"*',
          '3. Record and send your audio',
          '',
          '*On mobile:*',
          '1. Tap the *microphone* icon in the message field',
          '2. Hold to record',
          '3. Release to send',
          '',
          "I'll listen to your audio, transcribe it, and give you feedback on pronunciation and grammar.",
          '',
          '*Tip:* Add the text "check my pronunciation" when sending a voice memo to get detailed pronunciation feedback with audio demos of words you need to work on.',
        ].join('\n'),
      },
    },
  ];
}

// ── Step 4: Channel Guide + First Exercise ─────────────────

export function buildChannelGuideBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Channels', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`#daily-lesson` — Monday to Friday at 9am, a new lesson.',
          '`#lunfardo-del-dia` — Every day at noon, a new lunfardo (slang) word.',
          '`#repaso` — Spaced repetition flashcards (SRS) to memorize vocabulary.',
          '`#desafios` — Practice with other students.',
        ].join('\n'),
      },
    },
  ];
}

export function buildFirstExerciseBlocks(level: number): Record<string, unknown>[] {
  const exercises: Record<number, { prompt: string; hint: string }> = {
    1: {
      prompt: 'Introduce yourself: say your name and where you\'re from.',
      hint: 'Example: "Hola, me llamo Juan y soy de Nueva York."',
    },
    2: {
      prompt: 'Tell me what you like to do in your free time.',
      hint: 'Example: "Me gusta cocinar y escuchar música."',
    },
    3: {
      prompt: 'Tell me about your last trip. Where did you go and what did you do?',
      hint: 'Try using past tense: "Fui a...", "Visité...", "Comí..."',
    },
    4: {
      prompt: 'What do you think about mate? Have you ever tried it?',
      hint: 'Use voseo: "Yo creo que...", "A mí me parece..."',
    },
    5: {
      prompt: 'Tell me a cool story from one of your trips.',
      hint: 'Go all out — lunfardo, slang, whatever you\'ve got.',
    },
  };

  const exercise = exercises[level] ?? exercises[1];

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Your First Exercise', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${exercise.prompt}*`,
          '',
          `_${exercise.hint}_`,
          '',
          'Reply right here with text or a voice memo. Give it a try!',
        ].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'If you get stuck, use `/gringo help` or type "no entiendo" and I\'ll explain in English.',
        },
      ],
    },
  ];
}
