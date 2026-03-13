import { log } from './logger';

const retryLog = log.withScope('retry');

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  isRetryable: (err: unknown) => boolean;
  label?: string;
}

/**
 * Retries an async function with linear backoff.
 * Only retries when isRetryable returns true for the thrown error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxAttempts, delayMs, isRetryable, label } = opts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt >= maxAttempts) {
        throw err;
      }

      const delay = delayMs * attempt;
      retryLog.warn(
        `${label ?? 'Operation'} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  // Safety net — should not reach here
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
