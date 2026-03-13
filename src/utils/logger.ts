export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

function parseLogLevel(raw: string | undefined): LogLevel {
  const normalized = (raw ?? 'info').toLowerCase();
  if (normalized in LEVEL_VALUES) return normalized as LogLevel;
  return 'info';
}

export class Logger {
  private scope: string;
  private threshold: number;

  constructor(scope: string, level?: LogLevel) {
    this.scope = scope;
    this.threshold = LEVEL_VALUES[level ?? parseLogLevel(process.env.LOG_LEVEL)];
  }

  withScope(scope: string): Logger {
    const child = new Logger(scope);
    child.threshold = this.threshold;
    return child;
  }

  trace(message: string, metadata?: Record<string, unknown>): void {
    this.log('trace', message, metadata);
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log('error', message, metadata);
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (LEVEL_VALUES[level] < this.threshold) return;

    const timestamp = new Date().toISOString();
    const label = LEVEL_LABELS[level];
    const metaStr = metadata && Object.keys(metadata).length > 0
      ? ` ${JSON.stringify(metadata)}`
      : '';

    const line = `${timestamp} [${label}] [${this.scope}] ${message}${metaStr}`;

    if (LEVEL_VALUES[level] >= LEVEL_VALUES.error) {
      console.error(line);
    } else if (LEVEL_VALUES[level] >= LEVEL_VALUES.warn) {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

export const log = new Logger('app');
