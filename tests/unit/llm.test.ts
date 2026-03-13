import { describe, it, expect } from 'vitest';
import {
  extractTextFromResponse,
  isRetryableError,
  classifyLlmError,
} from '../../src/services/llm';
import { GringoError } from '../../src/errors/gringoError';
import { TimeoutError } from '../../src/utils/timeout';

describe('extractTextFromResponse', () => {
  it('should extract text from a single text block', () => {
    const content = [{ type: 'text' as const, text: 'Hola mundo' }];
    expect(extractTextFromResponse(content)).toBe('Hola mundo');
  });

  it('should concatenate multiple text blocks', () => {
    const content = [
      { type: 'text' as const, text: 'Hola ' },
      { type: 'text' as const, text: 'mundo' },
    ];
    expect(extractTextFromResponse(content)).toBe('Hola mundo');
  });

  it('should skip non-text blocks', () => {
    const content = [
      { type: 'text' as const, text: 'Hola' },
      { type: 'tool_use' as const, id: '1', name: 'test', input: {} },
      { type: 'text' as const, text: ' mundo' },
    ] as any;
    expect(extractTextFromResponse(content)).toBe('Hola mundo');
  });

  it('should return empty string for no text blocks', () => {
    const content = [
      { type: 'tool_use' as const, id: '1', name: 'test', input: {} },
    ] as any;
    expect(extractTextFromResponse(content)).toBe('');
  });

  it('should return empty string for empty content array', () => {
    expect(extractTextFromResponse([])).toBe('');
  });
});

describe('isRetryableError', () => {
  it('should return true for TimeoutError', () => {
    expect(isRetryableError(new TimeoutError(5000))).toBe(true);
  });

  it('should return false for GringoError', () => {
    const err = new GringoError({ message: 'test', code: 'ERR_LLM_RESPONSE' });
    expect(isRetryableError(err)).toBe(false);
  });

  it('should return false for generic Error', () => {
    expect(isRetryableError(new Error('random'))).toBe(false);
  });

  it('should return false for non-errors', () => {
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('classifyLlmError', () => {
  const meta = { model: 'test-model', attempt: 1, traceId: 'trace-abc' };

  it('should return the same GringoError if already one', () => {
    const original = new GringoError({ message: 'already classified', code: 'ERR_DB_QUERY' });
    const result = classifyLlmError(original, meta);
    expect(result).toBe(original);
  });

  it('should classify TimeoutError as ERR_LLM_TIMEOUT', () => {
    const err = new TimeoutError(30000);
    const result = classifyLlmError(err, meta);
    expect(result).toBeInstanceOf(GringoError);
    expect(result.code).toBe('ERR_LLM_TIMEOUT');
    expect(result.trace_id).toBe('trace-abc');
    expect(result.metadata?.model).toBe('test-model');
  });

  it('should classify unknown errors as ERR_LLM_RESPONSE', () => {
    const err = new Error('something weird');
    const result = classifyLlmError(err, meta);
    expect(result.code).toBe('ERR_LLM_RESPONSE');
    expect(result.message).toContain('something weird');
  });

  it('should handle non-Error thrown values', () => {
    const result = classifyLlmError('just a string', meta);
    expect(result.code).toBe('ERR_LLM_RESPONSE');
    expect(result.message).toContain('just a string');
  });

  it('should include attempt and model in metadata', () => {
    const result = classifyLlmError(new Error('fail'), { model: 'haiku', attempt: 2 });
    expect(result.metadata?.model).toBe('haiku');
    expect(result.metadata?.attempt).toBe(2);
  });
});
