import { GringoError, type GringoErrorCode } from './gringoError';

const USER_MESSAGES: Record<GringoErrorCode, string> = {
  ERR_UNKNOWN: 'Something went wrong. Please try again.',
  ERR_CONFIG_MISSING: 'The bot is misconfigured. Let an admin know.',
  ERR_DB_INIT: 'Could not initialize the database. Let an admin know.',
  ERR_DB_QUERY: 'Database error. Please try again in a moment.',
  ERR_SLACK_API: 'Slack API error. Please try again.',
  ERR_LLM_TIMEOUT: 'The AI took too long to respond. Please try again.',
  ERR_LLM_RATE_LIMIT: 'Too many requests. Wait a moment and try again.',
  ERR_LLM_RESPONSE: 'Got an unexpected response from the AI. Please try again.',
  ERR_STT_FAILED: 'Could not transcribe your audio. Try recording again.',
  ERR_TTS_FAILED: 'Could not generate audio. Please try again.',
  ERR_VOICE_DOWNLOAD: 'Could not download your audio from Slack. Try sending it again.',
  ERR_USER_NOT_FOUND: 'You are not registered yet. Try `/gringo help` to get started.',
  ERR_PERMISSION_DENIED: 'That action is admin-only.',
  ERR_INVALID_INPUT: 'Invalid input. Please check and try again.',
  ERR_SESSION_CONFLICT: 'You already have an active session. Finish it first.',
};

const CONTACT_SUFFIX = ' If this keeps happening, contact Joshua Song.';

export function formatUserFacingError(err: unknown): string {
  let msg: string;
  if (err instanceof GringoError) {
    msg = err.userMessage ?? USER_MESSAGES[err.code] ?? USER_MESSAGES.ERR_UNKNOWN;
  } else {
    msg = USER_MESSAGES.ERR_UNKNOWN;
  }
  return msg + CONTACT_SUFFIX;
}
