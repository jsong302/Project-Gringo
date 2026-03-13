export type GringoErrorCode =
  | 'ERR_UNKNOWN'
  | 'ERR_CONFIG_MISSING'
  | 'ERR_DB_INIT'
  | 'ERR_DB_QUERY'
  | 'ERR_SLACK_API'
  | 'ERR_LLM_TIMEOUT'
  | 'ERR_LLM_RATE_LIMIT'
  | 'ERR_LLM_RESPONSE'
  | 'ERR_STT_FAILED'
  | 'ERR_TTS_FAILED'
  | 'ERR_VOICE_DOWNLOAD'
  | 'ERR_USER_NOT_FOUND'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_INVALID_INPUT'
  | 'ERR_SESSION_CONFLICT';

export class GringoError extends Error {
  readonly code: GringoErrorCode;
  readonly userMessage?: string;
  readonly metadata?: Record<string, unknown>;
  trace_id?: string;

  constructor(opts: {
    message: string;
    code: GringoErrorCode;
    userMessage?: string;
    metadata?: Record<string, unknown>;
    trace_id?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'GringoError';
    this.code = opts.code;
    this.userMessage = opts.userMessage;
    this.metadata = opts.metadata;
    this.trace_id = opts.trace_id;
  }
}

export function toGringoError(err: unknown, fallbackCode: GringoErrorCode): GringoError {
  if (err instanceof GringoError) return err;

  const message = err instanceof Error ? err.message : String(err);
  return new GringoError({
    message,
    code: fallbackCode,
    cause: err,
  });
}
