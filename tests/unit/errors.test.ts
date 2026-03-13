import { describe, it, expect } from 'vitest';
import { GringoError, toGringoError } from '../../src/errors/gringoError';
import { formatUserFacingError } from '../../src/errors/formatUserFacingError';

describe('GringoError', () => {
  it('should create an error with code and message', () => {
    const err = new GringoError({
      message: 'test error',
      code: 'ERR_UNKNOWN',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GringoError);
    expect(err.message).toBe('test error');
    expect(err.code).toBe('ERR_UNKNOWN');
    expect(err.name).toBe('GringoError');
  });

  it('should include optional fields', () => {
    const err = new GringoError({
      message: 'test',
      code: 'ERR_LLM_TIMEOUT',
      userMessage: 'custom message',
      metadata: { model: 'haiku' },
      trace_id: 'abc123',
    });
    expect(err.userMessage).toBe('custom message');
    expect(err.metadata).toEqual({ model: 'haiku' });
    expect(err.trace_id).toBe('abc123');
  });

  it('should preserve cause', () => {
    const cause = new Error('original');
    const err = new GringoError({
      message: 'wrapped',
      code: 'ERR_UNKNOWN',
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});

describe('toGringoError', () => {
  it('should return the same GringoError if already one', () => {
    const original = new GringoError({ message: 'test', code: 'ERR_DB_QUERY' });
    const result = toGringoError(original, 'ERR_UNKNOWN');
    expect(result).toBe(original);
    expect(result.code).toBe('ERR_DB_QUERY');
  });

  it('should wrap a standard Error', () => {
    const original = new Error('standard error');
    const result = toGringoError(original, 'ERR_SLACK_API');
    expect(result).toBeInstanceOf(GringoError);
    expect(result.message).toBe('standard error');
    expect(result.code).toBe('ERR_SLACK_API');
    expect(result.cause).toBe(original);
  });

  it('should wrap a string', () => {
    const result = toGringoError('string error', 'ERR_UNKNOWN');
    expect(result.message).toBe('string error');
    expect(result.code).toBe('ERR_UNKNOWN');
  });

  it('should wrap null/undefined', () => {
    const result = toGringoError(null, 'ERR_UNKNOWN');
    expect(result.message).toBe('null');
    expect(result.code).toBe('ERR_UNKNOWN');
  });
});

describe('formatUserFacingError', () => {
  it('should return the userMessage if set', () => {
    const err = new GringoError({
      message: 'internal details',
      code: 'ERR_UNKNOWN',
      userMessage: 'Custom user message',
    });
    expect(formatUserFacingError(err)).toBe('Custom user message');
  });

  it('should return Spanish message for ERR_LLM_TIMEOUT', () => {
    const err = new GringoError({ message: 'timeout', code: 'ERR_LLM_TIMEOUT' });
    const msg = formatUserFacingError(err);
    expect(msg).toContain('mate');
  });

  it('should return Spanish message for ERR_STT_FAILED', () => {
    const err = new GringoError({ message: 'stt fail', code: 'ERR_STT_FAILED' });
    const msg = formatUserFacingError(err);
    expect(msg).toContain('audio');
  });

  it('should return Spanish message for ERR_PERMISSION_DENIED', () => {
    const err = new GringoError({ message: 'denied', code: 'ERR_PERMISSION_DENIED' });
    const msg = formatUserFacingError(err);
    expect(msg).toContain('admins');
  });

  it('should return default message for non-GringoError', () => {
    const msg = formatUserFacingError(new Error('random'));
    expect(msg).toContain('algo salió mal');
  });

  it('should return default message for unknown throw values', () => {
    const msg = formatUserFacingError('just a string');
    expect(msg).toContain('algo salió mal');
  });
});
