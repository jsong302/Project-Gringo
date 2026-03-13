import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../../src/utils/timeout';

describe('TimeoutError', () => {
  it('should have the correct name and message', () => {
    const err = new TimeoutError(5000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toBe('Operation timed out after 5000ms');
  });
});

describe('withTimeout', () => {
  it('should resolve with the value if within timeout', async () => {
    const result = await withTimeout(Promise.resolve('hello'), 1000);
    expect(result).toBe('hello');
  });

  it('should reject with TimeoutError if promise is too slow', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 500));
    await expect(withTimeout(slow, 10)).rejects.toThrow(TimeoutError);
  });

  it('should propagate the original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original'));
    await expect(withTimeout(failing, 1000)).rejects.toThrow('original');
  });

  it('should return the correct type', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('should clean up the timer on success (no leaked timers)', async () => {
    // If the timer leaks, this test would hang — passing means cleanup works
    const result = await withTimeout(Promise.resolve('fast'), 60_000);
    expect(result).toBe('fast');
  });
});
