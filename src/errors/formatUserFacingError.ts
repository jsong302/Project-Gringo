import { GringoError, type GringoErrorCode } from './gringoError';

const USER_MESSAGES: Record<GringoErrorCode, string> = {
  ERR_UNKNOWN: 'Uy, algo salió mal. Intentá de nuevo, che.',
  ERR_CONFIG_MISSING: 'El bot está mal configurado. Avisale al admin.',
  ERR_DB_INIT: 'No pude arrancar la memoria. Avisale al admin.',
  ERR_DB_QUERY: 'Se me trabó la memoria. Intentá en un ratito.',
  ERR_SLACK_API: 'Slack no me deja hacer eso ahora. Probá de nuevo.',
  ERR_LLM_TIMEOUT: 'El cerebro del bot se tomó un mate y no volvió. Probá de nuevo.',
  ERR_LLM_RATE_LIMIT: 'Estoy pensando demasiado. Dame un minutito y probá de nuevo.',
  ERR_LLM_RESPONSE: 'Me confundí pensando. Probá de nuevo, dale.',
  ERR_STT_FAILED: 'No pude entender el audio. Grabalo de vuelta, dale.',
  ERR_TTS_FAILED: 'No pude generar el audio. Intentá de nuevo.',
  ERR_VOICE_DOWNLOAD: 'No pude bajar tu audio de Slack. Probá mandarlo de nuevo.',
  ERR_USER_NOT_FOUND: 'No te tengo registrado. Probá con `/gringo help` para empezar.',
  ERR_PERMISSION_DENIED: 'Eh, eso es solo para admins.',
  ERR_INVALID_INPUT: 'No entendí lo que me mandaste. Fijate y probá de nuevo.',
  ERR_SESSION_CONFLICT: 'Ya tenés una sesión activa. Terminala primero.',
};

export function formatUserFacingError(err: unknown): string {
  if (err instanceof GringoError) {
    return err.userMessage ?? USER_MESSAGES[err.code] ?? USER_MESSAGES.ERR_UNKNOWN;
  }
  return USER_MESSAGES.ERR_UNKNOWN;
}
