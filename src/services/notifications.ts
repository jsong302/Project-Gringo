/**
 * Notifications — DM reminders for SRS reviews and daily lessons.
 *
 * Respects user notification preferences and quiet hours.
 */
import { getAllUsers, getNotificationPrefs, type User, type NotificationPrefs } from './userService';
import { getUserCardStats } from './srsRepository';
import { log } from '../utils/logger';

const notifLog = log.withScope('notifications');

// ── Quiet hours ─────────────────────────────────────────────

/**
 * Check if the current time falls within a user's quiet hours.
 */
export function isQuietHours(prefs: NotificationPrefs, timezone: string): boolean {
  const start = prefs.quietStart; // e.g. "22:00"
  const end = prefs.quietEnd;     // e.g. "08:00"
  if (!start || !end) return false;

  let nowHour: number;
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false });
    nowHour = parseInt(timeStr.split(':')[0], 10) + parseInt(timeStr.split(':')[1], 10) / 60;
  } catch {
    return false; // Invalid timezone — don't block
  }

  const startHour = parseTimeToHours(start);
  const endHour = parseTimeToHours(end);

  if (startHour <= endHour) {
    // Same-day range (e.g. 08:00 - 18:00)
    return nowHour >= startHour && nowHour < endHour;
  } else {
    // Overnight range (e.g. 22:00 - 08:00)
    return nowHour >= startHour || nowHour < endHour;
  }
}

function parseTimeToHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + (m || 0) / 60;
}

// ── SRS Reminders ───────────────────────────────────────────

/**
 * Send SRS review reminders to users with cards due.
 * Call from a daily cron job (e.g. 10:00 AM).
 */
export async function sendSrsReminders(client: any): Promise<number> {
  const users = getAllUsers();
  let sent = 0;

  for (const user of users) {
    const prefs = getNotificationPrefs(user.id);
    if (!prefs.srsReminders) continue;
    if (isQuietHours(prefs, user.timezone)) continue;

    const stats = getUserCardStats(user.id);
    if (stats.due === 0) continue;

    try {
      const dm = await client.conversations.open({ users: user.slackUserId });
      const ch = dm.channel?.id;
      if (!ch) continue;

      await client.chat.postMessage({
        channel: ch,
        text: `You have ${stats.due} card${stats.due === 1 ? '' : 's'} due for review! Use \`/gringo repaso\` to start a session.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*📚 Review Reminder*\nYou have *${stats.due}* card${stats.due === 1 ? '' : 's'} due for review today.\n\nUse \`/gringo repaso\` to start a session!`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Total cards: ${stats.total} | Learning: ${stats.learning} | Reviewing: ${stats.reviewing}`,
              },
            ],
          },
        ],
      });

      sent++;
    } catch (err) {
      notifLog.error(`Failed to send SRS reminder to ${user.slackUserId}: ${err}`);
    }
  }

  if (sent > 0) {
    notifLog.info(`Sent SRS reminders to ${sent} users`);
  }
  return sent;
}

// ── Daily lesson DM notifications ───────────────────────────

/**
 * Notify users via DM that a new daily lesson has been posted.
 * Call after posting the lesson to the channel.
 */
export async function sendLessonNotifications(
  client: any,
  channelId: string,
  lessonTitle: string,
): Promise<number> {
  const users = getAllUsers();
  let sent = 0;

  for (const user of users) {
    const prefs = getNotificationPrefs(user.id);
    if (!prefs.dailyLessons) continue;
    if (isQuietHours(prefs, user.timezone)) continue;

    try {
      const dm = await client.conversations.open({ users: user.slackUserId });
      const ch = dm.channel?.id;
      if (!ch) continue;

      await client.chat.postMessage({
        channel: ch,
        text: `New daily lesson: ${lessonTitle}! Head to <#${channelId}> to check it out.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*📚 New Daily Lesson*\n*${lessonTitle}*\n\nHead to <#${channelId}> to check it out and practice with a voice response!`,
            },
          },
        ],
      });

      sent++;
    } catch (err) {
      notifLog.error(`Failed to send lesson notification to ${user.slackUserId}: ${err}`);
    }
  }

  if (sent > 0) {
    notifLog.info(`Sent lesson notifications to ${sent} users`);
  }
  return sent;
}

// ── Onboarding follow-up ────────────────────────────────────

/**
 * Send encouraging follow-up DM to users who onboarded recently but haven't practiced.
 * "Recently" = onboarded 24h ago, no practice since.
 */
export async function sendOnboardingFollowUp(client: any): Promise<number> {
  const users = getAllUsers();
  const now = Date.now();
  let sent = 0;

  for (const user of users) {
    if (!user.onboarded) continue;
    if (user.lastPracticeAt) continue; // Already practiced

    // Check if onboarded roughly 24h ago (between 20h and 28h ago)
    const createdAt = new Date(user.createdAt.endsWith('Z') ? user.createdAt : user.createdAt + 'Z').getTime();
    const hoursSinceCreation = (now - createdAt) / (1000 * 60 * 60);
    if (hoursSinceCreation < 20 || hoursSinceCreation > 28) continue;

    const prefs = getNotificationPrefs(user.id);
    if (isQuietHours(prefs, user.timezone)) continue;

    try {
      const dm = await client.conversations.open({ users: user.slackUserId });
      const ch = dm.channel?.id;
      if (!ch) continue;

      await client.chat.postMessage({
        channel: ch,
        text: '¡Che! Just checking in — ready to start practicing your Argentine Spanish? Send me a message to start a conversation, or try `/gringo repaso` for a flashcard session!',
      });

      sent++;
    } catch (err) {
      notifLog.error(`Failed to send onboarding follow-up to ${user.slackUserId}: ${err}`);
    }
  }

  if (sent > 0) {
    notifLog.info(`Sent onboarding follow-ups to ${sent} users`);
  }
  return sent;
}
