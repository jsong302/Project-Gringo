/**
 * Onboarding Service — Block Kit builders for the new-user welcome flow.
 *
 * Flow:
 *  1. Welcome message explaining Gringo
 *  2. Self-assessment via buttons (No Spanish / Some basics / Conversational / Advanced)
 *  3. Placement test (multiple choice) OR skip for beginners
 *  4. Response mode preference (text vs voice feedback)
 *  5. Voice memo tutorial
 *  6. Channel guide
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
          "There's a small group learning together for our Argentina mission trip. We'll chat, practice with voice memos, and review vocabulary every day.",
        ].join('\n'),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*Here\'s how to get started:*',
          '',
          '*Step 1:* Tell me your Spanish level below (quick placement test or skip)',
          '*Step 2:* Pick how you want feedback (text or voice)',
          '*Step 3:* Head to the *Home* tab — that\'s your dashboard for lessons, exercises, and progress',
          '*Step 4:* Chat with me here in DMs anytime to practice conversational Spanish',
          '',
          "Let's start with Step 1 — where are you at with Spanish?",
        ].join('\n'),
      },
    },
  ];
}

// ── Step 2: Self-Assessment ────────────────────────────────

export function buildSelfAssessmentBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How much Spanish do you know?*',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'No Spanish', emoji: true },
          action_id: 'onboard_assess_1',
          value: '1',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Some basics', emoji: true },
          action_id: 'onboard_assess_2',
          value: '2',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Conversational', emoji: true },
          action_id: 'onboard_assess_3',
          value: '3',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Advanced', emoji: true },
          action_id: 'onboard_assess_4',
          value: '4',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "_No Spanish = never studied | Some basics = greetings, simple sentences | Conversational = can chat | Advanced = pretty fluent_",
        },
      ],
    },
  ];
}

// ── Step 3: Placement Result ───────────────────────────────

export function buildPlacementSkipBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "No worries! We'll start from the very beginning. You'll be placed at *Unit 1* (Level 1).",
      },
    },
  ];
}

export function buildPlacementStartBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Let's find out exactly where you should start. I'll ask you a few quick multiple-choice questions — just tap the answers!",
      },
    },
  ];
}

// ── Step 3b: Response Mode Preference ─────────────────────

export function buildResponseModeBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How would you like to get feedback when you make a mistake?*',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Text + pronunciation', emoji: true },
          action_id: 'onboard_response_text',
          value: 'text',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Voice memo', emoji: true },
          action_id: 'onboard_response_voice',
          value: 'voice',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "_Text = written feedback + Spanish audio clip | Voice = full explanation spoken in English + Spanish correction — you can change this anytime_",
        },
      ],
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

// ── Step 4: Channel Guide ───────────────────────────────────

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
          '`#desafios` — Practice with other students.',
          '',
          '_Use `/gringo repaso` in our DM to review your SRS flashcards._',
        ].join('\n'),
      },
    },
  ];
}

