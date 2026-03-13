/**
 * Review Handler — Wires the SRS review session into Slack.
 *
 * Handles:
 *  - `/gringo repaso` command (start a review session)
 *  - `srs_show_answer` button action (reveal answer + score buttons)
 *  - `srs_again|hard|good|easy` button actions (score and advance)
 */
import type { App } from '@slack/bolt';
import { log } from '../utils/logger';
import { getDb } from '../db';
import { runWithObservabilityContext, getTraceId } from '../observability/context';
import {
  startReviewSession,
  getCurrentCard,
  scoreCardByLabel,
  completeSession,
  getActiveSession,
  formatCardBlocks,
  formatAnswerBlocks,
  formatSummaryBlocks,
} from '../services/reviewSession';
import { createCardsForUser, getUserCardStats } from '../services/srsRepository';
import type { QualityLabel } from '../services/srs';
import { getMaxCardsPerSession } from '../services/settings';

const reviewLog = log.withScope('review-handler');

// ── Helpers ─────────────────────────────────────────────────

/**
 * Look up internal user ID from Slack user ID.
 * Creates the user if they don't exist.
 */
export function ensureUser(slackUserId: string): number {
  const db = getDb();

  const result = db.exec(
    `SELECT id FROM users WHERE slack_user_id = '${slackUserId}'`,
  );
  if (result.length && result[0].values.length) {
    return result[0].values[0][0] as number;
  }

  // Auto-create user
  db.run(
    `INSERT INTO users (slack_user_id) VALUES ('${slackUserId}')`,
  );
  const newResult = db.exec(
    `SELECT id FROM users WHERE slack_user_id = '${slackUserId}'`,
  );
  return newResult[0].values[0][0] as number;
}

/**
 * Ensure user has SRS cards. If they have none, create cards from all content.
 */
export function ensureUserHasCards(userId: number): void {
  const stats = getUserCardStats(userId);
  if (stats.total > 0) return;

  const db = getDb();

  // Get all content IDs
  const vocab = db.exec('SELECT id FROM vocabulary');
  const conj = db.exec('SELECT id FROM conjugations');
  const phrases = db.exec('SELECT id FROM phrases');
  const vesre = db.exec('SELECT id FROM vesre');

  const cards: Array<{ cardType: 'vocab' | 'conjugation' | 'phrase' | 'vesre'; contentId: number }> = [];

  if (vocab.length) vocab[0].values.forEach((r) => cards.push({ cardType: 'vocab', contentId: r[0] as number }));
  if (conj.length) conj[0].values.forEach((r) => cards.push({ cardType: 'conjugation', contentId: r[0] as number }));
  if (phrases.length) phrases[0].values.forEach((r) => cards.push({ cardType: 'phrase', contentId: r[0] as number }));
  if (vesre.length) vesre[0].values.forEach((r) => cards.push({ cardType: 'vesre', contentId: r[0] as number }));

  createCardsForUser(userId, cards);
  reviewLog.info(`Auto-created ${cards.length} SRS cards for user ${userId}`);
}

// ── Command handler ─────────────────────────────────────────

export async function handleRepaso(
  userId: number,
  channelId: string,
  respond: (msg: any) => Promise<void>,
): Promise<void> {
  // Ensure user has cards
  ensureUserHasCards(userId);

  // Check for active session
  const existing = getActiveSession(userId, channelId);
  if (existing) {
    await respond({
      response_type: 'ephemeral',
      text: 'Ya tenés una sesión de repaso activa. Terminala primero!',
    });
    return;
  }

  // Start session
  const threadTs = Date.now().toString();
  const maxCards = getMaxCardsPerSession();
  const session = startReviewSession(userId, channelId, threadTs, maxCards);

  if (!session) {
    const stats = getUserCardStats(userId);
    await respond({
      response_type: 'ephemeral',
      text: `No tenés cartas pendientes para repasar! 🎉\nTotal de cartas: ${stats.total} | En aprendizaje: ${stats.learning} | En repaso: ${stats.reviewing}`,
    });
    return;
  }

  // Present first card
  const presented = getCurrentCard(session);
  if (!presented) {
    await respond({ response_type: 'ephemeral', text: 'Error interno — no se pudo cargar la carta.' });
    return;
  }

  const blocks = [
    ...formatCardBlocks(presented),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '👁 Mostrar respuesta' },
          action_id: 'srs_show_answer',
          value: String(presented.card.id),
          style: 'primary',
        },
      ],
    },
  ];

  await respond({
    response_type: 'ephemeral',
    text: `Repaso: Carta ${presented.cardNumber}/${presented.totalCards}`,
    blocks,
  });
}

// ── Action handlers ─────────────────────────────────────────

export function registerReviewActions(app: App): void {
  // Show answer button
  app.action('srs_show_answer', async ({ ack, body, respond }) => {
    await ack();

    await runWithObservabilityContext(async () => {
      try {
        const slackUserId = body.user.id;
        const channelId = (body as any).channel?.id ?? 'DM';
        const userId = ensureUser(slackUserId);
        const session = getActiveSession(userId, channelId);

        if (!session) {
          await respond({ response_type: 'ephemeral', text: 'No tenés una sesión activa. Usá `/gringo repaso` para empezar.' });
          return;
        }

        const presented = getCurrentCard(session);
        if (!presented) {
          await respond({ response_type: 'ephemeral', text: 'No hay más cartas.' });
          return;
        }

        const blocks = formatAnswerBlocks(presented.content);
        await respond({
          response_type: 'ephemeral',
          text: `Respuesta: ${presented.content.back}`,
          blocks,
        });
      } catch (err) {
        reviewLog.error(`Show answer failed: ${err}`);
        await respond({ response_type: 'ephemeral', text: 'Error mostrando la respuesta.' });
      }
    });
  });

  // Score buttons (again, hard, good, easy)
  for (const label of ['again', 'hard', 'good', 'easy'] as QualityLabel[]) {
    app.action(`srs_${label}`, async ({ ack, body, respond }) => {
      await ack();

      await runWithObservabilityContext(async () => {
        try {
          const slackUserId = body.user.id;
          const channelId = (body as any).channel?.id ?? 'DM';
          const userId = ensureUser(slackUserId);
          const session = getActiveSession(userId, channelId);

          if (!session) {
            await respond({ response_type: 'ephemeral', text: 'No tenés una sesión activa.' });
            return;
          }

          // Score current card
          scoreCardByLabel(session, label);

          // Check if there are more cards
          const next = getCurrentCard(session);
          if (!next) {
            // Session complete
            const summary = completeSession(userId, channelId);
            if (summary) {
              const blocks = formatSummaryBlocks(summary);
              await respond({
                response_type: 'ephemeral',
                text: 'Repaso completado!',
                blocks,
              });
            }
            return;
          }

          // Present next card
          const blocks = [
            ...formatCardBlocks(next),
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '👁 Mostrar respuesta' },
                  action_id: 'srs_show_answer',
                  value: String(next.card.id),
                  style: 'primary',
                },
              ],
            },
          ];

          await respond({
            response_type: 'ephemeral',
            text: `Repaso: Carta ${next.cardNumber}/${next.totalCards}`,
            blocks,
          });
        } catch (err) {
          reviewLog.error(`Score (${label}) failed: ${err}`);
          await respond({ response_type: 'ephemeral', text: 'Error procesando tu respuesta.' });
        }
      });
    });
  }

  reviewLog.info('Review action handlers registered');
}
