/**
 * Onboarding Service — Block Kit builders for the new-user welcome flow.
 *
 * Flow:
 *  1. Welcome message explaining Gringo
 *  2. Level assessment via buttons (1-5)
 *  3. Voice memo tutorial
 *  4. Channel guide + first exercise prompt
 *
 * Each step is a separate message so the user can scroll back.
 */

// ── Step 1: Welcome ────────────────────────────────────────

export function buildWelcomeBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Bienvenido a Gringo!', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Soy *Gringo*, tu profe de español argentino. Te voy a enseñar a hablar como un porteño — con voseo, lunfardo, y toda la onda.',
          '',
          'Acá hay un grupo chico (6-15 personas) aprendiendo juntos. Vamos a charlar, practicar con audio, y repasar vocabulario todos los días.',
          '',
          'Primero, necesito saber tu nivel para adaptar las lecciones. Dale, elegí el que te parezca:',
        ].join('\n'),
      },
    },
  ];
}

// ── Step 2: Level Assessment ───────────────────────────────

export function buildLevelPickerBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Cuál es tu nivel de español?*',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '1 - Nada', emoji: true },
          action_id: 'onboard_level_1',
          value: '1',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '2 - Poco', emoji: true },
          action_id: 'onboard_level_2',
          value: '2',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '3 - Intermedio', emoji: true },
          action_id: 'onboard_level_3',
          value: '3',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '4 - Avanzado', emoji: true },
          action_id: 'onboard_level_4',
          value: '4',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '5 - Nativo/Fluido', emoji: true },
          action_id: 'onboard_level_5',
          value: '5',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_1 = nunca estudié español | 2 = sé algo básico | 3 = puedo mantener una conversación | 4 = bastante fluido | 5 = casi nativo_',
        },
      ],
    },
  ];
}

// ── Step 3: Level Confirmation + Voice Tutorial ────────────

const LEVEL_DESCRIPTIONS: Record<number, string> = {
  1: 'Principiante absoluto — vamos a empezar desde cero, tranqui.',
  2: 'Principiante — ya sabés algo, vamos a construir sobre eso.',
  3: 'Intermedio — podés charlar, ahora vamos a pulir.',
  4: 'Avanzado — hora de hablar como un verdadero porteño.',
  5: 'Experto — vamos a perfeccionar con lunfardo y modismos.',
};

export function buildLevelConfirmationBlocks(level: number): Record<string, unknown>[] {
  const desc = LEVEL_DESCRIPTIONS[level] ?? '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Nivel ${level}* — ${desc}\n\nPodés cambiar tu nivel cuando quieras con \`/gringo level <1-5>\`.`,
      },
    },
  ];
}

export function buildVoiceTutorialBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Clave: los audios de voz', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Practicar hablando es la parte más importante. Slack tiene audios integrados:',
          '',
          '*En desktop:*',
          '1. Hacé click en el icono *+* a la izquierda del campo de mensaje',
          '2. Elegí *"Record audio clip"*',
          '3. Grabá tu audio y mandalo',
          '',
          '*En celular:*',
          '1. Tocá el ícono del *micrófono* en el campo de mensaje',
          '2. Mantené presionado para grabar',
          '3. Soltá para enviar',
          '',
          'Yo voy a escuchar tu audio, transcribirlo, y darte feedback sobre pronunciación y gramática.',
        ].join('\n'),
      },
    },
  ];
}

// ── Step 4: Channel Guide + First Exercise ─────────────────

export function buildChannelGuideBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Los canales', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`#charla-libre` — Conversación libre conmigo en español. Mandá texto o audio y yo te respondo.',
          '`#daily-lesson` — Lunes a viernes a las 9am, una lección nueva.',
          '`#lunfardo-del-dia` — Todos los días al mediodía, una palabra de lunfardo.',
          '`#repaso` — Tarjetas de repaso espaciado (SRS) para memorizar vocabulario.',
          '`#desafios` — Práctica con otros estudiantes.',
        ].join('\n'),
      },
    },
  ];
}

export function buildFirstExerciseBlocks(level: number): Record<string, unknown>[] {
  const exercises: Record<number, { prompt: string; hint: string }> = {
    1: {
      prompt: 'Presentate: decí tu nombre y de dónde sos.',
      hint: 'Ejemplo: "Hola, me llamo Juan y soy de Nueva York."',
    },
    2: {
      prompt: 'Contame qué te gusta hacer en tu tiempo libre.',
      hint: 'Ejemplo: "Me gusta cocinar y escuchar música."',
    },
    3: {
      prompt: 'Contame sobre tu último viaje. Adónde fuiste y qué hiciste?',
      hint: 'Intentá usar el pasado: "Fui a...", "Visité...", "Comí..."',
    },
    4: {
      prompt: 'Qué opinás del mate? Lo probaste alguna vez? Contame.',
      hint: 'Usá voseo: "Yo creo que...", "A mí me parece..."',
    },
    5: {
      prompt: 'Che, contame alguna anécdota copada que te haya pasado viajando.',
      hint: 'Dale con todo — lunfardo, modismos, lo que quieras.',
    },
  };

  const exercise = exercises[level] ?? exercises[1];

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Tu primer ejercicio', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${exercise.prompt}*`,
          '',
          `_${exercise.hint}_`,
          '',
          'Podés responder por texto o con un audio en `#charla-libre`. Dale, animate!',
        ].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Cualquier duda, mandame `/gringo help` o escribime "no entiendo" y te explico en inglés.',
        },
      ],
    },
  ];
}
