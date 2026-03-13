import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, log } from '../../src/utils/logger';

describe('Logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a logger with default scope', () => {
    const logger = new Logger('test');
    expect(logger).toBeInstanceOf(Logger);
  });

  it('should create a child logger with withScope', () => {
    const child = log.withScope('db');
    expect(child).toBeInstanceOf(Logger);
  });

  it('should log info messages', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('test', 'info');
    logger.info('hello');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('[INF]');
    expect(spy.mock.calls[0][0]).toContain('[test]');
    expect(spy.mock.calls[0][0]).toContain('hello');
  });

  it('should log warn messages to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = new Logger('test', 'info');
    logger.warn('careful');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('[WRN]');
  });

  it('should log error messages to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger('test', 'info');
    logger.error('broken');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('[ERR]');
  });

  it('should filter messages below the configured level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('test', 'warn');
    logger.debug('should not appear');
    logger.info('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('should include metadata in output', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('test', 'info');
    logger.info('with data', { key: 'value' });
    expect(spy.mock.calls[0][0]).toContain('"key":"value"');
  });

  it('should include timestamp in ISO format', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('test', 'info');
    logger.info('timestamp check');
    // ISO format: 2026-03-12T...Z
    expect(spy.mock.calls[0][0]).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
