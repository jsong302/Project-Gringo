import type { RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

export async function respondEphemeral(
  respond: RespondFn,
  text: string,
  blocks?: Record<string, unknown>[],
): Promise<void> {
  await respond({
    response_type: 'ephemeral',
    text,
    ...(blocks ? { blocks } : {}),
  });
}

export async function postMessage(
  client: WebClient,
  channel: string,
  text: string,
  blocks?: Record<string, unknown>[],
  threadTs?: string,
): Promise<void> {
  await client.chat.postMessage({
    channel,
    text,
    ...(blocks ? { blocks } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

export function buildHelpBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Bienvenido a Gringo — Tu profe de argentino',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Gringo te enseña español rioplatense — con voseo, lunfardo, y onda porteña. Acá tenés todo lo que necesitás saber:',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Canales*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`#daily-lesson` — Lección diaria: vocabulario, gramática, cultura, y ejercicio de voz',
          '`#charla-libre` — Conversación abierta con el bot en español argentino',
          '`#lunfardo-del-dia` — Palabra de lunfardo nueva cada día con etimología',
          '`#repaso` — Sesiones de repaso espaciado (SRS)',
          '`#desafios` — Práctica en parejas con escenarios',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Comandos*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`/gringo help` — Esta guía',
          '`/gringo level` — Ver o cambiar tu nivel (1-5)',
          '`/gringo stats` — Tu racha, palabras aprendidas, y progreso',
          '`/gringo notifications` — Configurar recordatorios y horarios',
          '`/conjugar <verbo>` — Tabla de conjugación voseante',
          '`/vocab <palabra>` — Buscar una palabra con contexto',
          '`/repaso` — Empezar sesión de repaso',
          '`/charlar <escenario>` — Simulación de diálogo',
          '`/shadow` — Ejercicio de imitación',
          '`/desafio` — Desafío en pareja',
          '`/feedback <mensaje>` — Decile al bot qué onda',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Tu nivel actual: usá `/gringo level` para verlo. Dale que va!',
        },
      ],
    },
  ];
}
