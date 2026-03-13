import { GringoError } from '../errors/gringoError';
import { log } from '../utils/logger';
import type { Config } from './types';

const configLog = log.withScope('config');

function req(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new GringoError({
      message: `Missing required environment variable: ${name}`,
      code: 'ERR_CONFIG_MISSING',
      metadata: { variable: name },
    });
  }
  return value.trim();
}

function opt(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}

function optInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return defaultValue;
  const parsed = parseInt(raw.trim(), 10);
  if (isNaN(parsed)) {
    configLog.warn(`Invalid integer for ${name}: "${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function optBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  configLog.warn(`Invalid boolean for ${name}: "${raw}", using default ${defaultValue}`);
  return defaultValue;
}

export function loadConfig(): Config {
  const config: Config = {
    slack: {
      botToken: req('SLACK_BOT_TOKEN'),
      signingSecret: req('SLACK_SIGNING_SECRET'),
      appToken: req('SLACK_APP_TOKEN'),
    },
    db: {
      path: opt('DB_PATH', './data/gringo.db'),
    },
    app: {
      logLevel: opt('LOG_LEVEL', 'info'),
      port: optInt('PORT', 3000),
      adminUserIds: opt('ADMIN_USER_IDS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
  };

  // Optional API configs — only loaded if their key is present
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    config.anthropic = {
      apiKey: anthropicKey,
      model: opt('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
      maxTokens: optInt('ANTHROPIC_MAX_TOKENS', 1024),
    };
  }

  const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (deepgramKey) {
    config.deepgram = {
      apiKey: deepgramKey,
    };
  }

  const ttsKey = process.env.GOOGLE_TTS_API_KEY?.trim();
  if (ttsKey) {
    config.tts = {
      apiKey: ttsKey,
      voice: opt('TTS_VOICE', 'es-US-Standard-A'),
      languageCode: opt('TTS_LANGUAGE_CODE', 'es-AR'),
    };
  }

  return config;
}

function mask(value: string): string {
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***';
}

export function printConfigSnapshot(config: Config): void {
  configLog.info('Configuration loaded:');
  configLog.info(`  slack.botToken: ${mask(config.slack.botToken)}`);
  configLog.info(`  slack.signingSecret: ${mask(config.slack.signingSecret)}`);
  configLog.info(`  slack.appToken: ${mask(config.slack.appToken)}`);
  configLog.info(`  db.path: ${config.db.path}`);
  configLog.info(`  app.logLevel: ${config.app.logLevel}`);
  configLog.info(`  app.port: ${config.app.port}`);
  configLog.info(`  app.adminUserIds: [${config.app.adminUserIds.join(', ')}]`);
  configLog.info(`  anthropic: ${config.anthropic ? `configured (model: ${config.anthropic.model})` : 'not configured'}`);
  configLog.info(`  deepgram: ${config.deepgram ? 'configured' : 'not configured'}`);
  configLog.info(`  tts: ${config.tts ? `configured (voice: ${config.tts.voice})` : 'not configured'}`);
}
