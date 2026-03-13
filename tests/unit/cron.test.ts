import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runJob,
  createDefaultJobs,
  scheduleJobs,
  stopAllJobs,
  getRunningJobNames,
} from '../../src/scheduler/cron';
import type { ScheduledJob } from '../../src/scheduler/cron';

describe('runJob', () => {
  it('should execute the handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: ScheduledJob = { name: 'test-job', schedule: '* * * * *', handler };

    await runJob(job);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should not throw when handler fails', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const job: ScheduledJob = { name: 'failing-job', schedule: '* * * * *', handler };

    // Should not throw — errors are caught and logged
    await expect(runJob(job)).resolves.toBeUndefined();
  });
});

describe('createDefaultJobs', () => {
  it('should create two jobs', () => {
    const jobs = createDefaultJobs({
      postDailyLesson: vi.fn(),
      postLunfardoDelDia: vi.fn(),
    });

    expect(jobs).toHaveLength(2);
  });

  it('should name jobs correctly', () => {
    const jobs = createDefaultJobs({
      postDailyLesson: vi.fn(),
      postLunfardoDelDia: vi.fn(),
    });

    const names = jobs.map((j) => j.name);
    expect(names).toContain('daily-lesson');
    expect(names).toContain('lunfardo-del-dia');
  });

  it('should have valid cron expressions', () => {
    const cron = require('node-cron');
    const jobs = createDefaultJobs({
      postDailyLesson: vi.fn(),
      postLunfardoDelDia: vi.fn(),
    });

    for (const job of jobs) {
      expect(cron.validate(job.schedule)).toBe(true);
    }
  });

  it('should wire up the provided handlers', () => {
    const lessonFn = vi.fn();
    const lunfardoFn = vi.fn();

    const jobs = createDefaultJobs({
      postDailyLesson: lessonFn,
      postLunfardoDelDia: lunfardoFn,
    });

    const dailyJob = jobs.find((j) => j.name === 'daily-lesson');
    const lunfardoJob = jobs.find((j) => j.name === 'lunfardo-del-dia');

    expect(dailyJob?.handler).toBe(lessonFn);
    expect(lunfardoJob?.handler).toBe(lunfardoFn);
  });
});

describe('scheduleJobs / stopAllJobs', () => {
  afterEach(() => {
    stopAllJobs();
  });

  it('should register jobs and track them', () => {
    const jobs: ScheduledJob[] = [
      { name: 'job-a', schedule: '* * * * *', handler: vi.fn() },
      { name: 'job-b', schedule: '0 9 * * *', handler: vi.fn() },
    ];

    scheduleJobs(jobs);
    expect(getRunningJobNames()).toEqual(['job-a', 'job-b']);
  });

  it('should skip jobs with invalid cron expressions', () => {
    const jobs: ScheduledJob[] = [
      { name: 'valid', schedule: '* * * * *', handler: vi.fn() },
      { name: 'invalid', schedule: 'not-a-cron', handler: vi.fn() },
    ];

    scheduleJobs(jobs);
    expect(getRunningJobNames()).toEqual(['valid']);
  });

  it('should stop all jobs and clear the list', () => {
    scheduleJobs([
      { name: 'job-1', schedule: '* * * * *', handler: vi.fn() },
    ]);

    expect(getRunningJobNames()).toHaveLength(1);
    stopAllJobs();
    expect(getRunningJobNames()).toHaveLength(0);
  });
});
