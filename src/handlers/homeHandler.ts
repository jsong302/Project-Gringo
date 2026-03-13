/**
 * App Home Tab Handler — renders the Gringo dashboard and interactive lesson/exercise/SRS flows.
 *
 * The Home tab is state-driven: `HomeSessionState.view` determines what's rendered.
 * Views: dashboard (default), lesson (lesson+exercise), grade (after submission),
 *        srs_review (card review), srs_summary (review complete).
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { runWithObservabilityContext } from '../observability/context';
import { getOrCreateUser } from '../services/userService';
import { getUserCardStats } from '../services/srsRepository';
import { getErrorSummary } from '../services/errorTracker';
import {
  getCurrentUnit,
  getUserCurriculumProgress,
  activateNextUnit,
  generateUnitExercise,
  markUnitPracticing,
  gradeExerciseResponse,
  markUnitPassed,
  recordAttempt,
  getLessonFromBank,
  generateAndBankLesson,
  getCachedExercise,
  cacheExercise,
} from '../services/curriculumDelivery';
import type { GradeResult } from '../services/curriculumDelivery';
import { getCurriculumCount, getCurriculum } from '../services/curriculum';
import { getMemory } from '../services/userMemory';
import { isAdmin } from '../services/settings';
import { updateStreak } from '../services/userService';
import {
  getHomeSession,
  setHomeSession,
  clearHomeSession,
  createDefaultSession,
  publishHomeTab,
} from '../services/homeSession';
import type { HomeSessionState } from '../services/homeSession';
import { generatePronunciationAudio, generateCorrectionAudio } from '../services/pronunciation';
import { uploadAudioToSlack } from '../utils/slackAudio';

const homeLog = log.withScope('home-tab');

// ── Block Builders ──────────────────────────────────────────

function buildProgressBar(completed: number, total: number, width: number = 10): string {
  if (total === 0) return ':white_square:'.repeat(width);
  const filled = Math.min(Math.round((completed / total) * width), width);
  return ':large_green_square:'.repeat(filled) + ':white_square:'.repeat(width - filled);
}

function buildProfileBlocks(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const progress = getUserCurriculumProgress(user.id);
  const responseLabel = user.responseMode === 'voice' ? 'Voice' : 'Text';
  const streakEmoji = user.streakDays >= 7 ? ' :fire:' : '';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Gringo — Your Argentine Spanish Tutor', emoji: true },
    },
    {
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
    },
  ];
}

function buildProgressBlocks(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const progress = getUserCurriculumProgress(user.id);
  const current = getCurrentUnit(user.id);
  const totalUnits = getCurriculumCount();
  const pct = totalUnits > 0 ? Math.round((progress.completedCount / totalUnits) * 100) : 0;
  const bar = buildProgressBar(progress.completedCount, totalUnits);

  const lines = [
    `*:books: Curriculum Progress*   Unit ${progress.completedCount} of ${totalUnits}`,
    `${bar}  ${pct}%`,
  ];

  if (current) {
    const o = current.unit.unitOrder;
    if (o > 1) lines.push(`  :white_check_mark: Unit ${o - 1} — _completed_`);
    const label = current.progress.status === 'practicing' ? ':arrow_forward: practicing' : ':arrow_forward: active';
    lines.push(`  ${label} *Unit ${o} — ${current.unit.title}*`);
    if (o < totalUnits) lines.push(`  :lock: Unit ${o + 1} — _locked_`);
  } else if (progress.completedCount === totalUnits && totalUnits > 0) {
    lines.push('  :tada: *All units completed!*');
  } else {
    lines.push('  _No active unit — click Next Unit to start_');
  }

  return [
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
}

function buildStatsBlocks(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const cardStats = getUserCardStats(user.id);
  const errorSummary = getErrorSummary(user.id);
  const progress = getUserCurriculumProgress(user.id);
  const memory = getMemory(user.id);

  const errorLine = errorSummary.length > 0
    ? errorSummary.slice(0, 3).map((e) => `${e.category}: ${e.count}`).join(', ')
    : 'none yet';

  const blocks: Record<string, unknown>[] = [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*:bar_chart: Stats*`,
          `*SRS Cards:* ${cardStats.total} (${cardStats.due} due)  |  *Units Passed:* ${progress.completedCount}`,
          `*Common errors:* ${errorLine}`,
        ].join('\n'),
      },
    },
  ];

  if (memory && memory.profileSummary) {
    const profileLines = [`*:brain: Learner Profile*`, memory.profileSummary];
    if (memory.strengths) profileLines.push(`*Strengths:* ${memory.strengths}`);
    if (memory.weaknesses) profileLines.push(`*Areas to improve:* ${memory.weaknesses}`);
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: profileLines.join('\n') } });
  }

  return blocks;
}

function buildDashboardActions(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const cardStats = getUserCardStats(user.id);
  const current = getCurrentUnit(user.id);

  // Change button label based on whether user has an active lesson
  const hasActiveLesson = current && (current.progress.status === 'practicing' || current.progress.status === 'active');
  const state = getHomeSession(user.id);
  const hasStoredLesson = state?.view === 'lesson' || state?.view === 'grade';
  const nextLabel = hasActiveLesson || hasStoredLesson
    ? ':arrow_forward: Continue Lesson'
    : ':arrow_right: Next Unit';

  const srsLabel = cardStats.due > 0
    ? `:recycle: Practice SRS (${cardStats.due} due)`
    : ':recycle: Practice SRS';

  return [
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: nextLabel },
          action_id: 'home_next_unit',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: srsLabel },
          action_id: 'home_practice_srs',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':books: View Curriculum' },
          action_id: 'home_view_curriculum',
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_This dashboard updates each time you open the app._' }],
    },
  ];
}

// ── View: Dashboard ─────────────────────────────────────────

function buildDashboardView(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const state = getHomeSession(user.id);
  const blocks = [
    ...buildProfileBlocks(slackUserId),
    ...buildProgressBlocks(slackUserId),
    ...buildStatsBlocks(slackUserId),
  ];

  // Show inline notification if present (e.g. "no SRS cards due")
  if (state?.warningText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: state.warningText },
    });
    // Clear it after showing once
    state.warningText = null;
    setHomeSession(state);
  }

  blocks.push(...buildDashboardActions(slackUserId));
  return blocks;
}

// ── View: Lesson + Exercise ─────────────────────────────────

function buildLessonView(slackUserId: string, state: HomeSessionState): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [...buildProfileBlocks(slackUserId)];
  const unit = state.unit;
  const totalUnits = getCurriculumCount();

  if (unit && state.lessonText) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `Unit ${unit.unitOrder} of ${totalUnits}: ${unit.title}`, emoji: true },
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Level ${unit.levelBand} | ${unit.topic}_` }],
    });
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: state.lessonText },
    });
  }

  if (state.exerciseText) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*:pencil2: Exercise*\n\n${state.exerciseText}` },
    });

    const user = getOrCreateUser(slackUserId);
    const current = getCurrentUnit(user.id);
    const attempts = current?.progress.attempts ?? 0;
    const threshold = unit?.passThreshold ?? 3;
    const attemptLine = attempts > 0
      ? `Attempts: ${attempts}  |  Need: ${threshold}/5 to pass`
      : `Need: ${threshold}/5 to pass`;

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: attemptLine }],
    });

    // Show inline warning (e.g. non-attempt feedback) if present
    if (state.warningText) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: state.warningText },
      });
    }

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: ':memo: Answer' },
          action_id: 'home_exercise_answer',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':microphone: Send voice memo in DMs' },
          action_id: 'home_voice_hint',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':books: Back to Curriculum' },
          action_id: 'home_view_curriculum',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':leftwards_arrow_with_hook: Back to Dashboard' },
          action_id: 'home_back_dashboard',
        },
      ],
    });
  }

  return blocks;
}

// ── View: Grade Feedback ────────────────────────────────────

function buildGradeView(slackUserId: string, state: HomeSessionState): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [...buildProfileBlocks(slackUserId)];
  const grade = state.lastGradeResult;
  const unit = state.unit;

  if (!grade || !unit) return buildDashboardView(slackUserId);

  if (grade.passed) {
    // ── Pass view ──
    blocks.push(...buildProgressBlocks(slackUserId));
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Unit ${unit.unitOrder}: ${unit.title}* — Passed (${grade.score}/5)\n\n:tada: ${grade.feedback}`,
      },
    });
    blocks.push(...buildStatsBlocks(slackUserId));
    blocks.push(...buildDashboardActions(slackUserId));
  } else {
    // ── Fail view ──
    // Show the exercise text so the user remembers the question
    if (state.exerciseText) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*:pencil2: Exercise*\n\n${state.exerciseText}` },
      });
    }

    blocks.push({ type: 'divider' });

    const lines = [
      `:x: *Score: ${grade.score}/5* — need ${unit.passThreshold} to pass`,
      '',
      grade.feedback,
    ];

    if (grade.errors.length > 0) {
      lines.push('', '*Errors to work on:*');
      for (const err of grade.errors) {
        lines.push(`• ${err}`);
      }
    }

    if (grade.correction) {
      lines.push('', `*Correct answer:* _${grade.correction}_`);
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    });

    const user = getOrCreateUser(slackUserId);
    const current = getCurrentUnit(user.id);
    const attempts = current?.progress.attempts ?? 0;
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Attempts: ${attempts}  |  Need: ${unit.passThreshold}/5 to pass` }],
    });

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: ':memo: Try Again' },
          action_id: 'home_exercise_answer',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':microphone: Send voice memo in DMs' },
          action_id: 'home_voice_hint',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':books: Back to Curriculum' },
          action_id: 'home_view_curriculum',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: ':leftwards_arrow_with_hook: Back to Dashboard' },
          action_id: 'home_back_dashboard',
        },
      ],
    });
  }

  return blocks;
}

// ── View: SRS Review ────────────────────────────────────────

function buildSrsReviewView(slackUserId: string, state: HomeSessionState): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const review = state.srsReview;

  if (!review || review.currentIndex >= review.cardIds.length) {
    return buildSrsSummaryView(slackUserId, state);
  }

  const { getCardById } = require('../services/srsRepository');
  const { getCardContent } = require('../services/cardContent');

  const card = getCardById(review.cardIds[review.currentIndex]);
  const content = card ? getCardContent(card) : null;

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `SRS Review — Card ${review.currentIndex + 1} of ${review.cardIds.length}`, emoji: true },
  });
  blocks.push({ type: 'divider' });

  if (content) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${content.front}*` },
    });

    if (review.showingAnswer) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: content.back },
      });
      if (content.example) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_${content.example}_` }],
        });
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_How well did you know it?_' },
      });
      blocks.push({
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Again' }, action_id: 'home_srs_again', style: 'danger' },
          { type: 'button', text: { type: 'plain_text', text: 'Hard' }, action_id: 'home_srs_hard' },
          { type: 'button', text: { type: 'plain_text', text: 'Good' }, action_id: 'home_srs_good', style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Easy' }, action_id: 'home_srs_easy' },
        ],
      });
    } else {
      blocks.push({
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Show Answer' }, action_id: 'home_srs_show', style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Quit Review' }, action_id: 'home_srs_quit' },
        ],
      });
    }
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_Card content not found. Skipping..._' },
    });
  }

  return blocks;
}

// ── View: SRS Summary ───────────────────────────────────────

function buildSrsSummaryView(slackUserId: string, state: HomeSessionState): Record<string, unknown>[] {
  const review = state.srsReview;
  const blocks: Record<string, unknown>[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: 'SRS Review Complete!', emoji: true },
  });
  blocks.push({ type: 'divider' });

  if (review) {
    const counts = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const r of review.results) {
      if (r.quality <= 1) counts.again++;
      else if (r.quality === 2) counts.hard++;
      else if (r.quality <= 4) counts.good++;
      else counts.easy++;
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Reviewed:* ${review.results.length} cards`,
          `Again: ${counts.again}  |  Hard: ${counts.hard}  |  Good: ${counts.good}  |  Easy: ${counts.easy}`,
        ].join('\n'),
      },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: ':leftwards_arrow_with_hook: Back to Dashboard' },
        action_id: 'home_back_dashboard',
        style: 'primary',
      },
    ],
  });

  return blocks;
}

// ── View: Curriculum Browser ────────────────────────────────

function buildCurriculumView(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);
  const units = getCurriculum();
  const current = getCurrentUnit(user.id);
  const progress = getUserCurriculumProgress(user.id);

  // Build a lookup of unit statuses
  const { getDb } = require('../db');
  const db = getDb();
  const progressResult = db.exec(
    `SELECT unit_id, status, best_score FROM user_curriculum_progress WHERE user_id = ${user.id}`,
  );
  const unitStatus = new Map<number, { status: string; bestScore: number | null }>();
  if (progressResult.length) {
    for (const row of progressResult[0].values) {
      unitStatus.set(row[0] as number, {
        status: row[1] as string,
        bestScore: row[2] as number | null,
      });
    }
  }

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Curriculum', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${progress.completedCount}/${units.length} units completed` }],
    },
    { type: 'divider' },
  ];

  // Group units by level band
  let currentBand = 0;
  // Batch clickable units into action blocks (max 5 buttons per actions block)
  let actionButtons: Record<string, unknown>[] = [];

  const flushButtons = () => {
    if (actionButtons.length > 0) {
      blocks.push({ type: 'actions', elements: actionButtons });
      actionButtons = [];
    }
  };

  for (const unit of units) {
    if (unit.levelBand !== currentBand) {
      flushButtons();
      currentBand = unit.levelBand;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Level ${currentBand}*` },
      });
    }

    const prog = unitStatus.get(unit.id);
    const status = prog?.status ?? 'locked';
    const userIsAdmin = isAdmin(slackUserId);
    const isClickable = userIsAdmin || status === 'passed' || status === 'practicing' || status === 'active' || status === 'skipped';

    let icon: string;
    let suffix = '';
    switch (status) {
      case 'passed':
        icon = ':white_check_mark:';
        suffix = prog?.bestScore != null ? ` (${prog.bestScore}/5)` : '';
        break;
      case 'practicing':
        icon = ':arrow_forward:';
        suffix = ' in progress';
        break;
      case 'active':
        icon = ':radio_button:';
        suffix = ' ready';
        break;
      case 'skipped':
        icon = ':fast_forward:';
        suffix = ' skipped';
        break;
      default:
        icon = ':lock:';
        break;
    }

    if (isClickable) {
      actionButtons.push({
        type: 'button',
        text: { type: 'plain_text', text: `${icon} ${unit.unitOrder}. ${unit.title}${suffix}` },
        action_id: `home_goto_unit_${unit.id}`,
        ...(status === 'practicing' || status === 'active' ? { style: 'primary' } : {}),
      });
      // Slack allows max 5 buttons per actions block
      if (actionButtons.length >= 5) {
        flushButtons();
      }
    } else {
      flushButtons();
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${icon}  ${unit.unitOrder}. ${unit.title}` }],
      });
    }
  }
  flushButtons();

  // Slack Home tab has a 100-block limit — truncate if needed
  if (blocks.length > 95) {
    blocks.splice(95);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_... and more units. Use `/gringo progress` for the full list._' }],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: ':leftwards_arrow_with_hook: Back to Dashboard' },
        action_id: 'home_back_dashboard',
        style: 'primary',
      },
    ],
  });

  return blocks;
}

// ── Main block builder (exported for publishHomeTab) ────────

export function buildHomeBlocks(slackUserId: string): Record<string, unknown>[] {
  const user = getOrCreateUser(slackUserId);

  // Show welcome screen for users who haven't completed onboarding
  if (!user.onboarded) {
    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Gringo — Your Argentine Spanish Tutor', emoji: true },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            ':wave: *Welcome to Gringo!*',
            '',
            'I\'m your personal Argentine Spanish tutor for the Argentina mission trip. Let\'s get you set up!',
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*How to get started:*',
            '',
            ':one: *Check your DMs* — I sent you a welcome message (or type `/gringo onboard` to resend it)',
            ':two: *Take the placement test* (or skip if you\'re a beginner)',
            ':three: *Pick your feedback style* — text or voice',
            ':four: *Come back here* — this Home tab becomes your dashboard for lessons, exercises, and progress',
            ':five: *Chat with me in DMs* anytime to practice conversational Spanish',
          ].join('\n'),
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_This page will update automatically once setup is complete._' }],
      },
    ];
  }

  const state = getHomeSession(user.id);

  if (!state || state.view === 'dashboard') {
    return buildDashboardView(slackUserId);
  }

  switch (state.view) {
    case 'lesson':
      return buildLessonView(slackUserId, state);
    case 'grade':
      return buildGradeView(slackUserId, state);
    case 'srs_review':
      return buildSrsReviewView(slackUserId, state);
    case 'srs_summary':
      return buildSrsSummaryView(slackUserId, state);
    case 'curriculum':
      return buildCurriculumView(slackUserId);
    default:
      return buildDashboardView(slackUserId);
  }
}

// ── Registration ────────────────────────────────────────────

export function registerHomeHandler(app: App): void {
  // ── Render on open ──────────────────────────────────────
  app.event('app_home_opened', async ({ event, client }) => {
    await runWithObservabilityContext(async () => {
      const slackUserId = event.user;
      if ((event as any).tab !== 'home') return;

      try {
        await publishHomeTab(client, slackUserId);
        homeLog.debug(`Home tab rendered for ${slackUserId}`);
      } catch (err) {
        homeLog.error(`Failed to render Home tab for ${slackUserId}: ${err}`);
      }
    });
  });

  // ── Next Unit ───────────────────────────────────────────
  app.action('home_next_unit', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;

      try {
        const user = getOrCreateUser(slackUserId);

        // If there's already a lesson loaded, just show it (prevents double-click regeneration)
        const existingState = getHomeSession(user.id);
        if (existingState?.view === 'lesson' && existingState.lessonText && existingState.exerciseText
            && existingState.lessonText !== '_Generating your lesson..._') {
          await publishHomeTab(client, slackUserId);
          return;
        }

        let current = getCurrentUnit(user.id);

        if (!current || current.progress.status === 'passed') {
          const nextUnit = activateNextUnit(user.id);
          if (!nextUnit) {
            clearHomeSession(user.id);
            await publishHomeTab(client, slackUserId);
            return;
          }
          current = getCurrentUnit(user.id);
        }

        if (!current) {
          clearHomeSession(user.id);
          await publishHomeTab(client, slackUserId);
          return;
        }

        // Load shared lesson from bank (or generate on-demand if missing)
        let lessonText = getLessonFromBank(current.unit.id);
        // Load per-user cached exercise
        let exerciseText = getCachedExercise(user.id, current.unit.id);

        if (lessonText && exerciseText) {
          homeLog.info(`Using cached content for ${slackUserId}: Unit ${current.unit.unitOrder}`);
        } else {
          // Show loading state while generating
          const loadingState = createDefaultSession(user.id, slackUserId);
          loadingState.view = 'lesson';
          loadingState.unit = current.unit;
          loadingState.lessonText = '_Generating your lesson..._';
          setHomeSession(loadingState);
          await publishHomeTab(client, slackUserId);

          // Generate lesson from bank if missing (shared across all users)
          if (!lessonText) {
            lessonText = await generateAndBankLesson(current.unit.id);
          }
          // Generate per-user exercise if missing
          if (!exerciseText) {
            exerciseText = await generateUnitExercise(current.unit, user.id);
            cacheExercise(user.id, current.unit.id, exerciseText);
          }
        }

        // Mark unit as practicing
        markUnitPracticing(user.id, current.unit.id);

        // Update state with content
        const state = createDefaultSession(user.id, slackUserId);
        state.view = 'lesson';
        state.unit = current.unit;
        state.lessonText = lessonText;
        state.exerciseText = exerciseText;
        setHomeSession(state);
        await publishHomeTab(client, slackUserId);

        homeLog.info(`Lesson delivered on Home tab for ${slackUserId}: Unit ${current.unit.unitOrder}`);
      } catch (err) {
        homeLog.error(`Home next-unit action failed: ${err}`);
        // Fall back to dashboard on error
        const user = getOrCreateUser(slackUserId);
        clearHomeSession(user.id);
        await publishHomeTab(client, slackUserId);
      }
    });
  });

  // ── Exercise Answer (open modal) ────────────────────────
  app.action('home_exercise_answer', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        // Clear any previous warning when reopening the modal
        const slackUserId = body.user.id;
        const user = getOrCreateUser(slackUserId);
        const state = getHomeSession(user.id);
        if (state?.warningText) {
          state.warningText = null;
          setHomeSession(state);
          publishHomeTab(client, slackUserId).catch(() => {});
        }

        await client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'exercise_answer_modal',
            title: { type: 'plain_text', text: 'Your Answer' },
            submit: { type: 'plain_text', text: 'Submit' },
            blocks: [
              {
                type: 'input',
                block_id: 'answer_block',
                label: { type: 'plain_text', text: 'Type your answer in Spanish' },
                element: {
                  type: 'plain_text_input',
                  action_id: 'answer_input',
                  multiline: true,
                  placeholder: { type: 'plain_text', text: 'Escribí tu respuesta acá...' },
                },
              },
            ],
          },
        });
      } catch (err) {
        homeLog.error(`Failed to open exercise modal: ${err}`);
      }
    });
  });

  // ── Exercise Answer (modal submission) ──────────────────
  app.view('exercise_answer_modal', async ({ ack, body, view, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;

      try {
        const answer = view.state.values.answer_block.answer_input.value ?? '';
        const user = getOrCreateUser(slackUserId);
        const state = getHomeSession(user.id);
        const current = getCurrentUnit(user.id);

        if (!current || !state?.unit) {
          clearHomeSession(user.id);
          await publishHomeTab(client, slackUserId);
          return;
        }

        // Use the actual generated exercise text (what the user sees), not the template prompt
        const exerciseText = state.exerciseText ?? state.unit.exercisePrompt ?? state.unit.title;
        const grade = await gradeExerciseResponse(current.unit, exerciseText, answer, user.id, 'text');

        // If the LLM says it's not an attempt, stay on lesson view with inline warning
        if (!grade.isAttempt) {
          homeLog.info(`Non-exercise response in modal from ${slackUserId}: "${answer.slice(0, 60)}"`);
          state.warningText = ':thinking_face: That didn\'t look like an exercise answer. Try responding in Spanish to the exercise prompt. If you have a question, chat with me in DMs!';
          setHomeSession(state);
          await publishHomeTab(client, slackUserId);
          return;
        }

        if (grade.passed) {
          const { leveledUp, newLevel } = markUnitPassed(user.id, current.unit.id, grade.score);
          updateStreak(user.id);

          // Update state to show pass
          state.view = 'grade';
          state.lastGradeResult = grade;
          setHomeSession(state);
          await publishHomeTab(client, slackUserId);

          // Send pronunciation audio in DM if there's a correction
          if (grade.correction) {
            try {
              const dm = await client.conversations.open({ users: slackUserId });
              const dmChannel = dm.channel?.id;
              if (dmChannel) {
                const audioBuffers = await generatePronunciationAudio([grade.correction]);
                if (audioBuffers[0]) {
                  await uploadAudioToSlack(client, dmChannel, audioBuffers[0], grade.correction);
                }
              }
            } catch { /* audio is best-effort */ }
          }

          homeLog.info(`Unit ${current.unit.unitOrder} passed via Home tab by ${slackUserId} (${grade.score}/5)`);
        } else {
          recordAttempt(user.id, current.unit.id, grade.score);
          updateStreak(user.id);

          state.view = 'grade';
          state.lastGradeResult = grade;
          setHomeSession(state);
          await publishHomeTab(client, slackUserId);

          // Send audio feedback in DM based on response mode
          if (grade.correction) {
            try {
              const dm = await client.conversations.open({ users: slackUserId });
              const dmChannel = dm.channel?.id;
              if (dmChannel) {
                if (user.responseMode === 'voice') {
                  const audio = await generateCorrectionAudio(grade.feedback, grade.correction);
                  if (audio) {
                    await uploadAudioToSlack(client, dmChannel, audio, `Correction: ${grade.correction}`);
                  }
                } else {
                  const audioBuffers = await generatePronunciationAudio([grade.correction]);
                  if (audioBuffers[0]) {
                    await uploadAudioToSlack(client, dmChannel, audioBuffers[0], grade.correction);
                  }
                }
              }
            } catch { /* audio is best-effort */ }
          }

          homeLog.info(`Exercise failed via Home tab by ${slackUserId} (${grade.score}/5)`);
        }
      } catch (err) {
        homeLog.error(`Exercise grading failed: ${err}`);
      }
    });
  });

  // ── Voice hint (just notify them to use DMs) ────────────
  app.action('home_voice_hint', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      try {
        const dm = await client.conversations.open({ users: slackUserId });
        const dmChannel = dm.channel?.id;
        if (dmChannel) {
          await client.chat.postMessage({
            channel: dmChannel,
            text: ':microphone: Send a voice memo here with your answer and I\'ll grade it!',
          });
        }
      } catch (err) {
        homeLog.error(`Voice hint failed: ${err}`);
      }
    });
  });

  // ── Back to Dashboard ───────────────────────────────────
  app.action('home_back_dashboard', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      const user = getOrCreateUser(slackUserId);
      clearHomeSession(user.id);
      await publishHomeTab(client, slackUserId);
    });
  });

  // ── View Curriculum ──────────────────────────────────────
  app.action('home_view_curriculum', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      const user = getOrCreateUser(slackUserId);
      const state = getHomeSession(user.id) ?? createDefaultSession(user.id, slackUserId);
      state.view = 'curriculum';
      setHomeSession(state);
      await publishHomeTab(client, slackUserId);
    });
  });

  // ── SRS: Practice ───────────────────────────────────────
  app.action('home_practice_srs', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;

      try {
        const user = getOrCreateUser(slackUserId);
        const { getCardsDue } = require('../services/srsRepository');
        const cards = getCardsDue(user.id);

        if (cards.length === 0) {
          // Show "no cards" inline on Home tab
          const state = getHomeSession(user.id) ?? createDefaultSession(user.id, slackUserId);
          state.warningText = ':white_check_mark: No SRS cards due right now! Check back later.';
          setHomeSession(state);
          await publishHomeTab(client, slackUserId);
          return;
        }

        const maxCards = 10;
        const reviewCards = cards.slice(0, maxCards);

        const state = createDefaultSession(user.id, slackUserId);
        state.view = 'srs_review';
        state.srsReview = {
          cardIds: reviewCards.map((c: any) => c.id),
          currentIndex: 0,
          showingAnswer: false,
          results: [],
        };
        setHomeSession(state);
        await publishHomeTab(client, slackUserId);

        homeLog.info(`SRS review started on Home tab for ${slackUserId}: ${reviewCards.length} cards`);
      } catch (err) {
        homeLog.error(`Home SRS start failed: ${err}`);
      }
    });
  });

  // ── SRS: Show Answer ────────────────────────────────────
  app.action('home_srs_show', async ({ ack, body, client }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      const user = getOrCreateUser(slackUserId);
      const state = getHomeSession(user.id);

      if (state?.srsReview) {
        state.srsReview.showingAnswer = true;
        setHomeSession(state);
        await publishHomeTab(client, slackUserId);
      }
    });
  });

  // ── SRS: Grade (Again/Hard/Good/Easy) ───────────────────
  const srsGradeHandler = (quality: number) => async ({ ack, body, client }: any) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      const user = getOrCreateUser(slackUserId);
      const state = getHomeSession(user.id);

      if (!state?.srsReview) return;

      const review = state.srsReview;
      const cardId = review.cardIds[review.currentIndex];

      // Score the card via SM-2
      const { getCardById, updateCardAfterReview, logReview } = require('../services/srsRepository');
      const { sm2, qualityFromLabel } = require('../services/srs');

      const card = getCardById(cardId);
      if (card) {
        const sm2Card = { easeFactor: card.easeFactor, interval: card.intervalDays, repetitions: card.repetitions };
        const result = sm2(sm2Card, quality);
        updateCardAfterReview(cardId, result);
        logReview(user.id, cardId, quality, 'button');
      }

      // Record result and advance
      review.results.push({ cardId, quality });
      review.currentIndex++;
      review.showingAnswer = false;

      // Check if done
      if (review.currentIndex >= review.cardIds.length) {
        state.view = 'srs_summary';
      }

      setHomeSession(state);
      await publishHomeTab(client, slackUserId);
    });
  };

  // ── SRS: Quit early ──────────────────────────────────────
  app.action('home_srs_quit', async ({ ack, body, client }: any) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      const user = getOrCreateUser(slackUserId);
      const state = getHomeSession(user.id);

      if (state?.srsReview) {
        // Show summary of what was reviewed so far
        state.view = 'srs_summary';
        setHomeSession(state);
        await publishHomeTab(client, slackUserId);
      }
    });
  });

  app.action('home_srs_again', srsGradeHandler(1));
  app.action('home_srs_hard', srsGradeHandler(2));
  app.action('home_srs_good', srsGradeHandler(4));
  app.action('home_srs_easy', srsGradeHandler(5));

  // ── Curriculum: Go to unit ──────────────────────────────────
  app.action(/^home_goto_unit_\d+$/, async ({ ack, body, client }: any) => {
    await ack();

    await runWithObservabilityContext(async () => {
      const slackUserId = body.user.id;
      const actionId = body.actions?.[0]?.action_id as string;
      const unitId = parseInt(actionId.replace('home_goto_unit_', ''), 10);

      try {
        const user = getOrCreateUser(slackUserId);
        const { getUnit } = require('../services/curriculum');
        const unit = getUnit(unitId);
        if (!unit) return;

        // Load shared lesson from bank (generate on-demand if missing)
        let lessonText = getLessonFromBank(unitId);
        if (!lessonText) {
          // Show loading state
          const loadingState = createDefaultSession(user.id, slackUserId);
          loadingState.view = 'lesson';
          loadingState.unit = unit;
          loadingState.lessonText = '_Generating your lesson..._';
          setHomeSession(loadingState);
          await publishHomeTab(client, slackUserId);

          lessonText = await generateAndBankLesson(unitId);
        }

        // Load or generate per-user exercise
        let exerciseText = getCachedExercise(user.id, unitId);
        if (!exerciseText) {
          exerciseText = await generateUnitExercise(unit, user.id);
          cacheExercise(user.id, unitId, exerciseText);
        }

        // Mark as practicing if it's the current active/practicing unit
        const current = getCurrentUnit(user.id);
        if (current && current.unit.id === unitId) {
          markUnitPracticing(user.id, unitId);
        }

        const state = createDefaultSession(user.id, slackUserId);
        state.view = 'lesson';
        state.unit = unit;
        state.lessonText = lessonText;
        state.exerciseText = exerciseText;
        setHomeSession(state);
        await publishHomeTab(client, slackUserId);

        homeLog.info(`Curriculum nav to Unit ${unit.unitOrder} by ${slackUserId}`);
      } catch (err) {
        homeLog.error(`Curriculum goto failed: ${err}`);
      }
    });
  });

  homeLog.info('Home tab handler registered');
}
