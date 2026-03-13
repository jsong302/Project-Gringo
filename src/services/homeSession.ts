/**
 * Home Session State — manages per-user state for the App Home tab.
 *
 * Stores generated lesson/exercise text, grade results, and SRS review state
 * so the Home tab can render them without regeneration. Persisted to DB for
 * crash recovery. Follows the same pattern as reviewSession.ts and placementTest.ts.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';
import type { GradeResult } from './curriculumDelivery';
import type { CurriculumUnit } from './curriculum';

const homeLog = log.withScope('home-session');

// ── Types ───────────────────────────────────────────────────

export interface HomeSessionState {
  userId: number;
  slackUserId: string;
  /** Current view: dashboard, lesson, grade, srs_review, srs_summary, curriculum */
  view: 'dashboard' | 'lesson' | 'grade' | 'srs_review' | 'srs_summary' | 'curriculum';
  /** Generated lesson text (markdown) */
  lessonText: string | null;
  /** Generated exercise text (markdown) */
  exerciseText: string | null;
  /** The unit being studied */
  unit: CurriculumUnit | null;
  /** Last grading result (shown after exercise submission) */
  lastGradeResult: GradeResult | null;
  /** Inline warning shown on the lesson view (e.g. non-attempt feedback) */
  warningText: string | null;
  /** SRS review state (card IDs, current index, results) */
  srsReview: SrsHomeReview | null;
  updatedAt: number;
}

export interface SrsHomeReview {
  cardIds: number[];
  currentIndex: number;
  showingAnswer: boolean;
  results: Array<{ cardId: number; quality: number }>;
}

// ── In-memory store (keyed by userId) ───────────────────────

const sessions = new Map<number, HomeSessionState>();

export function getHomeSession(userId: number): HomeSessionState | null {
  return sessions.get(userId) ?? null;
}

export function setHomeSession(state: HomeSessionState): void {
  state.updatedAt = Date.now();
  sessions.set(state.userId, state);
  persistSession(state);
}

export function clearHomeSession(userId: number): void {
  sessions.delete(userId);
  deletePersistedSession(userId);
}

export function createDefaultSession(userId: number, slackUserId: string): HomeSessionState {
  return {
    userId,
    slackUserId,
    view: 'dashboard',
    lessonText: null,
    exerciseText: null,
    unit: null,
    lastGradeResult: null,
    warningText: null,
    srsReview: null,
    updatedAt: Date.now(),
  };
}

// ── DB persistence ──────────────────────────────────────────

function esc(str: string): string {
  return str.replace(/'/g, "''");
}

function persistSession(state: HomeSessionState): void {
  const db = getDb();
  const json = esc(JSON.stringify({
    view: state.view,
    lessonText: state.lessonText,
    exerciseText: state.exerciseText,
    unit: state.unit,
    lastGradeResult: state.lastGradeResult,
    srsReview: state.srsReview,
  }));
  db.run(
    `INSERT OR REPLACE INTO home_sessions (user_id, slack_user_id, state_json, updated_at)
     VALUES (${state.userId}, '${esc(state.slackUserId)}', '${json}', datetime('now'))`,
  );
}

function deletePersistedSession(userId: number): void {
  const db = getDb();
  db.run(`DELETE FROM home_sessions WHERE user_id = ${userId}`);
}

/**
 * Recover home sessions from DB on startup.
 * Only recovers sessions that have active lesson/exercise/review state
 * (not plain dashboard views).
 */
export function recoverHomeSessions(): number {
  const db = getDb();
  const result = db.exec(
    `SELECT user_id, slack_user_id, state_json FROM home_sessions`,
  );

  if (!result.length) return 0;

  let recovered = 0;
  for (const row of result[0].values) {
    try {
      const userId = row[0] as number;
      const slackUserId = row[1] as string;
      const stateJson = JSON.parse(row[2] as string);

      // Only recover sessions with meaningful state
      if (stateJson.view === 'dashboard') continue;

      const state: HomeSessionState = {
        userId,
        slackUserId,
        view: stateJson.view ?? 'dashboard',
        lessonText: stateJson.lessonText ?? null,
        exerciseText: stateJson.exerciseText ?? null,
        unit: stateJson.unit ?? null,
        lastGradeResult: stateJson.lastGradeResult ?? null,
        warningText: null,
        srsReview: stateJson.srsReview ?? null,
        updatedAt: Date.now(),
      };
      sessions.set(userId, state);
      recovered++;
    } catch (err) {
      homeLog.warn(`Failed to recover home session: ${err}`);
    }
  }

  if (recovered > 0) {
    homeLog.info(`Recovered ${recovered} home session(s) from DB`);
  }
  return recovered;
}

// ── Publish helper ──────────────────────────────────────────

/**
 * Publish (refresh) the Home tab for a user.
 * Imported and called from multiple places (action handlers, modal submissions,
 * message handler after voice grading).
 */
export async function publishHomeTab(client: any, slackUserId: string): Promise<void> {
  // Dynamically import to avoid circular dependency with homeHandler
  const { buildHomeBlocks } = await import('../handlers/homeHandler');
  try {
    const blocks = buildHomeBlocks(slackUserId);
    await client.views.publish({
      user_id: slackUserId,
      view: { type: 'home', blocks: blocks as any },
    });
  } catch (err) {
    homeLog.error(`Failed to publish Home tab for ${slackUserId}: ${err}`);
  }
}
