import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface ObservabilityContext {
  traceId: string;
}

const asyncContext = new AsyncLocalStorage<ObservabilityContext>();

export function createTraceId(): string {
  return randomBytes(8).toString('hex');
}

export function getTraceId(): string | undefined {
  return asyncContext.getStore()?.traceId;
}

export function runWithObservabilityContext<T>(fn: () => T, traceId?: string): T {
  const ctx: ObservabilityContext = {
    traceId: traceId ?? createTraceId(),
  };
  return asyncContext.run(ctx, fn);
}
