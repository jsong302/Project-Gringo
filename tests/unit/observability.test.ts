import { describe, it, expect } from 'vitest';
import {
  createTraceId,
  getTraceId,
  runWithObservabilityContext,
} from '../../src/observability/context';

describe('createTraceId', () => {
  it('should return a 16-character hex string', () => {
    const id = createTraceId();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('should return unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('runWithObservabilityContext', () => {
  it('should provide a trace ID inside the context', () => {
    const result = runWithObservabilityContext(() => {
      return getTraceId();
    });
    expect(result).toBeDefined();
    expect(result).toMatch(/^[a-f0-9]{16}$/);
  });

  it('should use a custom trace ID when provided', () => {
    const result = runWithObservabilityContext(() => {
      return getTraceId();
    }, 'custom123');
    expect(result).toBe('custom123');
  });

  it('should not leak context outside the callback', () => {
    runWithObservabilityContext(() => {
      // inside context
    });
    expect(getTraceId()).toBeUndefined();
  });

  it('should support async callbacks', async () => {
    const result = await runWithObservabilityContext(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getTraceId();
    });
    expect(result).toBeDefined();
    expect(result).toMatch(/^[a-f0-9]{16}$/);
  });

  it('should isolate nested contexts', () => {
    runWithObservabilityContext(() => {
      const outerTraceId = getTraceId();

      runWithObservabilityContext(() => {
        const innerTraceId = getTraceId();
        expect(innerTraceId).toBe('inner-id');
        expect(innerTraceId).not.toBe(outerTraceId);
      }, 'inner-id');

      // Outer context restored
      expect(getTraceId()).toBe(outerTraceId);
    });
  });
});
