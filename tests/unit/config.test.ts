import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, printConfigSnapshot } from '../../src/config/env';
import { GringoError } from '../../src/errors/gringoError';
import { vi } from 'vitest';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to clean state
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setRequiredEnv() {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token-12345';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_APP_TOKEN = 'xapp-test-app-token';
  }

  it('should throw GringoError when SLACK_BOT_TOKEN is missing', () => {
    process.env.SLACK_SIGNING_SECRET = 'test';
    process.env.SLACK_APP_TOKEN = 'test';
    delete process.env.SLACK_BOT_TOKEN;

    expect(() => loadConfig()).toThrow(GringoError);
    try {
      loadConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(GringoError);
      expect((err as GringoError).code).toBe('ERR_CONFIG_MISSING');
      expect((err as GringoError).message).toContain('SLACK_BOT_TOKEN');
    }
  });

  it('should throw GringoError when SLACK_SIGNING_SECRET is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'test';
    process.env.SLACK_APP_TOKEN = 'test';
    delete process.env.SLACK_SIGNING_SECRET;

    expect(() => loadConfig()).toThrow(GringoError);
  });

  it('should throw GringoError when SLACK_APP_TOKEN is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'test';
    process.env.SLACK_SIGNING_SECRET = 'test';
    delete process.env.SLACK_APP_TOKEN;

    expect(() => loadConfig()).toThrow(GringoError);
  });

  it('should load config with all required vars', () => {
    setRequiredEnv();
    const config = loadConfig();

    expect(config.slack.botToken).toBe('xoxb-test-token-12345');
    expect(config.slack.signingSecret).toBe('test-signing-secret');
    expect(config.slack.appToken).toBe('xapp-test-app-token');
  });

  it('should use default values for optional vars', () => {
    setRequiredEnv();
    const config = loadConfig();

    expect(config.db.path).toBe('./data/gringo.db');
    expect(config.app.logLevel).toBe('info');
    expect(config.app.port).toBe(3000);
    expect(config.app.adminUserIds).toEqual([]);
  });

  it('should parse optional vars when set', () => {
    setRequiredEnv();
    process.env.DB_PATH = '/custom/path.db';
    process.env.LOG_LEVEL = 'debug';
    process.env.PORT = '8080';
    process.env.ADMIN_USER_IDS = 'U123,U456,U789';

    const config = loadConfig();

    expect(config.db.path).toBe('/custom/path.db');
    expect(config.app.logLevel).toBe('debug');
    expect(config.app.port).toBe(8080);
    expect(config.app.adminUserIds).toEqual(['U123', 'U456', 'U789']);
  });

  it('should not set anthropic config when key is absent', () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.anthropic).toBeUndefined();
  });

  it('should load anthropic config when key is present', () => {
    setRequiredEnv();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const config = loadConfig();

    expect(config.anthropic).toBeDefined();
    expect(config.anthropic!.apiKey).toBe('sk-ant-test-key');
    expect(config.anthropic!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('should not set deepgram config when key is absent', () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.deepgram).toBeUndefined();
  });

  it('should load deepgram config when key is present', () => {
    setRequiredEnv();
    process.env.DEEPGRAM_API_KEY = 'dg-test-key';
    const config = loadConfig();

    expect(config.deepgram).toBeDefined();
    expect(config.deepgram!.apiKey).toBe('dg-test-key');
  });

  it('should handle invalid PORT gracefully', () => {
    setRequiredEnv();
    process.env.PORT = 'not-a-number';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadConfig();
    expect(config.app.port).toBe(3000); // falls back to default
  });

  it('should trim whitespace from env vars', () => {
    process.env.SLACK_BOT_TOKEN = '  xoxb-trimmed  ';
    process.env.SLACK_SIGNING_SECRET = '  secret  ';
    process.env.SLACK_APP_TOKEN = '  xapp-token  ';

    const config = loadConfig();
    expect(config.slack.botToken).toBe('xoxb-trimmed');
  });
});

describe('printConfigSnapshot', () => {
  it('should mask secrets in output', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printConfigSnapshot({
      slack: {
        botToken: 'xoxb-1234-abcdefghijk',
        signingSecret: 'abcdef1234567890',
        appToken: 'xapp-1-A1234-5678',
      },
      db: { path: './data/gringo.db' },
      app: { logLevel: 'info', port: 3000, adminUserIds: ['U123'] },
    });

    const output = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('xoxb***');
    expect(output).not.toContain('xoxb-1234-abcdefghijk');
    expect(output).toContain('abcd***');
    expect(output).not.toContain('abcdef1234567890');
    expect(output).toContain('xapp***');

    spy.mockRestore();
  });
});
