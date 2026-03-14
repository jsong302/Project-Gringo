import cron from 'node-cron';
import { log } from '../utils/logger';
import { runWithObservabilityContext } from '../observability/context';
import { toGringoError } from '../errors/gringoError';

const cronLog = log.withScope('cron');

// ── Types ───────────────────────────────────────────────────

export interface ScheduledJob {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
}

interface RunningJob {
  name: string;
  task: cron.ScheduledTask;
}

const runningJobs: RunningJob[] = [];

// ── Job runner (exported for testing) ───────────────────────

export async function runJob(job: ScheduledJob): Promise<void> {
  return runWithObservabilityContext(async () => {
    cronLog.info(`Running scheduled job: ${job.name}`);
    try {
      await job.handler();
      cronLog.info(`Job completed: ${job.name}`);
    } catch (err) {
      const gErr = toGringoError(err, 'ERR_UNKNOWN');
      cronLog.error(`Job failed: ${job.name} — ${gErr.message}`, {
        code: gErr.code,
      });
    }
  });
}

// ── Schedule management ─────────────────────────────────────

export function scheduleJobs(jobs: ScheduledJob[]): void {
  for (const job of jobs) {
    if (!cron.validate(job.schedule)) {
      cronLog.error(`Invalid cron expression for "${job.name}": ${job.schedule}`);
      continue;
    }

    const task = cron.schedule(job.schedule, () => {
      runJob(job);
    });

    runningJobs.push({ name: job.name, task });
    cronLog.info(`Scheduled "${job.name}" — ${job.schedule}`);
  }
}

export function stopAllJobs(): void {
  for (const { name, task } of runningJobs) {
    task.stop();
    cronLog.info(`Stopped job: ${name}`);
  }
  runningJobs.length = 0;
}

export function getRunningJobNames(): string[] {
  return runningJobs.map((j) => j.name);
}

// ── Default job definitions ─────────────────────────────────

/**
 * Creates the default set of scheduled jobs.
 * Pass in the actual handler functions so this module doesn't
 * import lesson engine directly (keeps it testable).
 */
export function createDefaultJobs(handlers: {
  postDailyLesson: () => Promise<void>;
  postLunfardoDelDia: () => Promise<void>;
  sendSrsReminders?: () => Promise<void>;
  closeStaleThreads?: () => Promise<void>;
  sendOnboardingFollowUp?: () => Promise<void>;
  refillQueues?: () => Promise<void>;
}): ScheduledJob[] {
  let dailyLessonSchedule = '0 9 * * 1-5';
  let lunfardoSchedule = '0 12 * * *';
  let refillSchedule = '0 11 * * *'; // 7 AM ET / 11:00 UTC daily

  try {
    const { getSetting } = require('../services/settings');
    dailyLessonSchedule = getSetting('cron.daily_lesson', dailyLessonSchedule) as string;
    lunfardoSchedule = getSetting('cron.lunfardo_del_dia', lunfardoSchedule) as string;
    refillSchedule = getSetting('cron.queue_refill', refillSchedule) as string;
  } catch {
    // Settings not available yet — use defaults
  }

  const jobs: ScheduledJob[] = [
    {
      name: 'daily-lesson',
      schedule: dailyLessonSchedule,
      handler: handlers.postDailyLesson,
    },
    {
      name: 'lunfardo-del-dia',
      schedule: lunfardoSchedule,
      handler: handlers.postLunfardoDelDia,
    },
  ];

  if (handlers.sendSrsReminders) {
    jobs.push({
      name: 'srs-reminders',
      schedule: '0 10 * * *', // 10 AM daily
      handler: handlers.sendSrsReminders,
    });
  }

  if (handlers.closeStaleThreads) {
    jobs.push({
      name: 'stale-thread-cleanup',
      schedule: '0 3 * * *', // 3 AM daily
      handler: handlers.closeStaleThreads,
    });
  }

  if (handlers.sendOnboardingFollowUp) {
    jobs.push({
      name: 'onboarding-follow-up',
      schedule: '0 * * * *', // Every hour
      handler: handlers.sendOnboardingFollowUp,
    });
  }

  if (handlers.refillQueues) {
    jobs.push({
      name: 'queue-refill',
      schedule: refillSchedule,
      handler: handlers.refillQueues,
    });
  }

  return jobs;
}
