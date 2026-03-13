import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/utils/retry';

describe('withRetry', () => {
  const defaultOpts = {
    maxAttempts: 3,
    delayMs: 10, // short for tests
    isRetryable: (err: unknown) => err instanceof Error && err.message === 'retryable',
  };

  it('should return the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, defaultOpts);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable errors and succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, defaultOpts);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw immediately on non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(withRetry(fn, defaultOpts)).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('retryable'));
    await expect(withRetry(fn, defaultOpts)).rejects.toThrow('retryable');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should respect maxAttempts = 1 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('retryable'));
    await expect(
      withRetry(fn, { ...defaultOpts, maxAttempts: 1 }),
    ).rejects.toThrow('retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should apply linear backoff between retries', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValue('ok');

    const start = Date.now();
    await withRetry(fn, { ...defaultOpts, delayMs: 50 });
    const elapsed = Date.now() - start;

    // First retry: 50ms, second retry: 100ms = ~150ms total
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('should pass the label through (no crash)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('retryable')).mockResolvedValue('ok');
    const result = await withRetry(fn, { ...defaultOpts, label: 'TestOp' });
    expect(result).toBe('ok');
  });
});
