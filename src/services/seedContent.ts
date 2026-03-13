/**
 * Seed Content — Initial vocabulary, conjugations, phrases, and vesre
 * for the SRS system.
 *
 * All content is Argentine Spanish (Rioplatense).
 * Seeding is idempotent — existing rows are skipped.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const seedLog = log.withScope('seed');

// ── Seed runners ────────────────────────────────────────────

export function seedAllContent(): void {
  seedVocabulary();
  seedConjugations();
  seedPhrases();
  seedVesre();
  seedLog.info('All content seeded');
}

export function seedVocabulary(): number {
  const db = getDb();
  let inserted = 0;
  for (const v of VOCABULARY) {
    const exists = db.exec(
      `SELECT 1 FROM vocabulary WHERE spanish = '${esc(v.spanish)}' AND english = '${esc(v.english)}'`,
    );
    if (exists.length && exists[0].values.length) continue;

    db.run(
      `INSERT INTO vocabulary (spanish, english, category, difficulty, example_sentence, is_lunfardo, etymology, cultural_notes, pronunciation_notes)
       VALUES ('${esc(v.spanish)}', '${esc(v.english)}', '${esc(v.category)}', ${v.difficulty},
               ${v.example ? `'${esc(v.example)}'` : 'NULL'},
               ${v.isLunfardo ? 1 : 0},
               ${v.etymology ? `'${esc(v.etymology)}'` : 'NULL'},
               ${v.culturalNotes ? `'${esc(v.culturalNotes)}'` : 'NULL'},
               ${v.pronunciation ? `'${esc(v.pronunciation)}'` : 'NULL'})`,
    );
    inserted++;
  }
  seedLog.info(`Vocabulary: ${inserted} new / ${VOCABULARY.length} total`);
  return inserted;
}

export function seedConjugations(): number {
  const db = getDb();
  let inserted = 0;
  for (const c of CONJUGATIONS) {
    const exists = db.exec(
      `SELECT 1 FROM conjugations WHERE verb_infinitive = '${esc(c.verb)}' AND tense = '${esc(c.tense)}' AND mood = '${esc(c.mood)}'`,
    );
    if (exists.length && exists[0].values.length) continue;

    db.run(
      `INSERT INTO conjugations (verb_infinitive, tense, mood, vos_form, tu_form, example_sentence, notes)
       VALUES ('${esc(c.verb)}', '${esc(c.tense)}', '${esc(c.mood)}', '${esc(c.vosForm)}',
               ${c.tuForm ? `'${esc(c.tuForm)}'` : 'NULL'},
               ${c.example ? `'${esc(c.example)}'` : 'NULL'},
               ${c.notes ? `'${esc(c.notes)}'` : 'NULL'})`,
    );
    inserted++;
  }
  seedLog.info(`Conjugations: ${inserted} new / ${CONJUGATIONS.length} total`);
  return inserted;
}

export function seedPhrases(): number {
  const db = getDb();
  let inserted = 0;
  for (const p of PHRASES) {
    const exists = db.exec(
      `SELECT 1 FROM phrases WHERE spanish = '${esc(p.spanish)}' AND english = '${esc(p.english)}'`,
    );
    if (exists.length && exists[0].values.length) continue;

    db.run(
      `INSERT INTO phrases (spanish, english, category, difficulty, context_notes, cultural_notes)
       VALUES ('${esc(p.spanish)}', '${esc(p.english)}', '${esc(p.category)}', ${p.difficulty},
               ${p.context ? `'${esc(p.context)}'` : 'NULL'},
               ${p.culturalNotes ? `'${esc(p.culturalNotes)}'` : 'NULL'})`,
    );
    inserted++;
  }
  seedLog.info(`Phrases: ${inserted} new / ${PHRASES.length} total`);
  return inserted;
}

export function seedVesre(): number {
  const db = getDb();
  let inserted = 0;
  for (const v of VESRE) {
    const exists = db.exec(
      `SELECT 1 FROM vesre WHERE original = '${esc(v.original)}' AND vesre_form = '${esc(v.vesreForm)}'`,
    );
    if (exists.length && exists[0].values.length) continue;

    db.run(
      `INSERT INTO vesre (original, vesre_form, meaning, example_sentence)
       VALUES ('${esc(v.original)}', '${esc(v.vesreForm)}',
               ${v.meaning ? `'${esc(v.meaning)}'` : 'NULL'},
               ${v.example ? `'${esc(v.example)}'` : 'NULL'})`,
    );
    inserted++;
  }
  seedLog.info(`Vesre: ${inserted} new / ${VESRE.length} total`);
  return inserted;
}

// ── Content data ────────────────────────────────────────────

interface VocabEntry {
  spanish: string;
  english: string;
  category: string;
  difficulty: number;
  example?: string;
  isLunfardo?: boolean;
  etymology?: string;
  culturalNotes?: string;
  pronunciation?: string;
}

export const VOCABULARY: VocabEntry[] = [
  // Level 1 — Básico
  { spanish: 'mate', english: 'mate (herbal tea)', category: 'comida', difficulty: 1, example: '¿Tomamos unos mates?', culturalNotes: 'Bebida nacional, se comparte en grupo' },
  { spanish: 'che', english: 'hey / buddy', category: 'expresiones', difficulty: 1, example: 'Che, ¿cómo andás?', isLunfardo: true, culturalNotes: 'Interjección usada constantemente en Argentina' },
  { spanish: 'bondi', english: 'bus', category: 'transporte', difficulty: 1, example: 'Tomé el bondi para ir al centro', isLunfardo: true, etymology: 'Del nombre de la empresa de tranvías Bond' },
  { spanish: 'pibe', english: 'kid / guy', category: 'personas', difficulty: 1, example: 'Ese pibe juega muy bien al fútbol', isLunfardo: true, etymology: 'Del italiano pivetto' },
  { spanish: 'mina', english: 'woman / girl', category: 'personas', difficulty: 1, example: 'Esa mina es re copada', isLunfardo: true, etymology: 'Del italiano femmina' },
  { spanish: 'guita', english: 'money', category: 'dinero', difficulty: 1, example: 'No tengo guita para salir', isLunfardo: true, etymology: 'Posiblemente del portugués' },
  { spanish: 'morfi', english: 'food', category: 'comida', difficulty: 1, example: 'Vamos a buscar morfi', isLunfardo: true, etymology: 'Del francés morfaler (comer)' },
  { spanish: 'birra', english: 'beer', category: 'comida', difficulty: 1, example: '¿Nos tomamos una birra?', isLunfardo: true, etymology: 'Del italiano birra' },
  { spanish: 'afanar', english: 'to steal', category: 'acciones', difficulty: 1, example: 'Me afanaron el celular', isLunfardo: true },
  { spanish: 'garpar', english: 'to pay', category: 'dinero', difficulty: 1, example: '¿Quién garpa la cuenta?', isLunfardo: true, etymology: 'Vesre de pagar' },

  // Level 2 — Intermedio bajo
  { spanish: 'laburo', english: 'work / job', category: 'trabajo', difficulty: 2, example: 'Tengo mucho laburo hoy', isLunfardo: true, etymology: 'Del italiano lavoro' },
  { spanish: 'copado', english: 'cool / awesome', category: 'adjetivos', difficulty: 2, example: 'Está re copado ese bar', isLunfardo: true },
  { spanish: 'fiaca', english: 'laziness', category: 'emociones', difficulty: 2, example: 'Me da fiaca salir con este frío', isLunfardo: true, etymology: 'Del italiano fiacca' },
  { spanish: 'macana', english: 'mistake / bummer', category: 'expresiones', difficulty: 2, example: '¡Qué macana! Se me rompió el auto', isLunfardo: true },
  { spanish: 'trucho', english: 'fake / counterfeit', category: 'adjetivos', difficulty: 2, example: 'Ese reloj es trucho', isLunfardo: true },
  { spanish: 'bancar', english: 'to support / to stand', category: 'acciones', difficulty: 2, example: 'No te banco más', isLunfardo: true },
  { spanish: 'chamuyar', english: 'to sweet-talk / to chat up', category: 'acciones', difficulty: 2, example: 'Ese pibe chamuya mucho', isLunfardo: true, etymology: 'Del caló (lengua gitana)' },
  { spanish: 'empanada', english: 'empanada (stuffed pastry)', category: 'comida', difficulty: 2, example: 'Las empanadas tucumanas son las mejores', culturalNotes: 'Cada provincia tiene su estilo' },
  { spanish: 'asado', english: 'barbecue', category: 'comida', difficulty: 2, example: 'El domingo hacemos un asado', culturalNotes: 'Ritual social importantísimo en Argentina' },
  { spanish: 'bardo', english: 'mess / trouble', category: 'expresiones', difficulty: 2, example: 'Se armó un bardo terrible', isLunfardo: true },

  // Level 3 — Intermedio
  { spanish: 'quilombo', english: 'chaos / mess', category: 'expresiones', difficulty: 3, example: 'La oficina es un quilombo', isLunfardo: true, etymology: 'Del quimbundo (lengua bantú)' },
  { spanish: 'morfar', english: 'to eat', category: 'acciones', difficulty: 3, example: '¿Vamos a morfar algo?', isLunfardo: true, etymology: 'Del francés morfaler' },
  { spanish: 'laburar', english: 'to work', category: 'trabajo', difficulty: 3, example: 'Estuve laburando todo el día', isLunfardo: true, etymology: 'Del italiano lavorare' },
  { spanish: 'afano', english: 'theft / rip-off', category: 'dinero', difficulty: 3, example: 'Esos precios son un afano', isLunfardo: true },
  { spanish: 'chabón', english: 'dude / guy', category: 'personas', difficulty: 3, example: 'Ese chabón es re piola', isLunfardo: true },
  { spanish: 'piola', english: 'cool / clever', category: 'adjetivos', difficulty: 3, example: 'Qué piola que está tu departamento', isLunfardo: true },
  { spanish: 'rescatarse', english: 'to calm down / to realize', category: 'acciones', difficulty: 3, example: 'Rescatate un poco, boludo', isLunfardo: true },
  { spanish: 'manija', english: 'craving / excitement', category: 'emociones', difficulty: 3, example: 'Tengo manija de ir al recital', isLunfardo: true },
  { spanish: 'garrón', english: 'drag / bad luck', category: 'expresiones', difficulty: 3, example: 'Qué garrón que llueva justo hoy', isLunfardo: true },
  { spanish: 'curtir', english: 'to enjoy / to do a lot', category: 'acciones', difficulty: 3, example: 'Estuve curtiendo la playa todo el día', isLunfardo: true },
];

interface ConjugationEntry {
  verb: string;
  tense: string;
  mood: string;
  vosForm: string;
  tuForm?: string;
  example?: string;
  notes?: string;
}

export const CONJUGATIONS: ConjugationEntry[] = [
  // -AR verbs presente
  { verb: 'hablar', tense: 'presente', mood: 'indicativo', vosForm: 'hablás', tuForm: 'hablas', example: 'Vos hablás muy rápido' },
  { verb: 'tomar', tense: 'presente', mood: 'indicativo', vosForm: 'tomás', tuForm: 'tomas', example: '¿Vos tomás mate?' },
  { verb: 'trabajar', tense: 'presente', mood: 'indicativo', vosForm: 'trabajás', tuForm: 'trabajas', example: 'Vos trabajás demasiado' },
  { verb: 'caminar', tense: 'presente', mood: 'indicativo', vosForm: 'caminás', tuForm: 'caminas', example: 'Vos caminás muy lento' },

  // -ER verbs presente
  { verb: 'comer', tense: 'presente', mood: 'indicativo', vosForm: 'comés', tuForm: 'comes', example: '¿Vos comés carne?' },
  { verb: 'tener', tense: 'presente', mood: 'indicativo', vosForm: 'tenés', tuForm: 'tienes', example: 'Vos tenés razón' },
  { verb: 'querer', tense: 'presente', mood: 'indicativo', vosForm: 'querés', tuForm: 'quieres', example: '¿Vos querés venir?' },
  { verb: 'poder', tense: 'presente', mood: 'indicativo', vosForm: 'podés', tuForm: 'puedes', example: '¿Vos podés ayudarme?' },

  // -IR verbs presente
  { verb: 'vivir', tense: 'presente', mood: 'indicativo', vosForm: 'vivís', tuForm: 'vives', example: '¿Vos vivís en Buenos Aires?' },
  { verb: 'salir', tense: 'presente', mood: 'indicativo', vosForm: 'salís', tuForm: 'sales', example: '¿A qué hora salís del laburo?' },
  { verb: 'decir', tense: 'presente', mood: 'indicativo', vosForm: 'decís', tuForm: 'dices', example: '¿Qué decís vos?' },
  { verb: 'venir', tense: 'presente', mood: 'indicativo', vosForm: 'venís', tuForm: 'vienes', example: '¿Venís a la juntada?' },

  // Ser / Estar / Ir
  { verb: 'ser', tense: 'presente', mood: 'indicativo', vosForm: 'sos', tuForm: 'eres', example: 'Vos sos muy copado', notes: 'Irregular. Vos sos (not vos sois)' },
  { verb: 'estar', tense: 'presente', mood: 'indicativo', vosForm: 'estás', tuForm: 'estás', example: '¿Cómo estás vos?', notes: 'Same for vos and tú in presente' },
  { verb: 'ir', tense: 'presente', mood: 'indicativo', vosForm: 'vas', tuForm: 'vas', example: '¿Adónde vas?', notes: 'Same for vos and tú. But imperativo: andá (vos) vs ve (tú)' },

  // Pretérito perfecto simple (some common ones)
  { verb: 'hablar', tense: 'pretérito', mood: 'indicativo', vosForm: 'hablaste', tuForm: 'hablaste', example: '¿Hablaste con tu viejo?', notes: 'Vos and tú share pretérito forms' },
  { verb: 'comer', tense: 'pretérito', mood: 'indicativo', vosForm: 'comiste', tuForm: 'comiste', example: '¿Comiste las empanadas?' },
  { verb: 'ir', tense: 'pretérito', mood: 'indicativo', vosForm: 'fuiste', tuForm: 'fuiste', example: '¿Fuiste al recital?' },

  // Imperativo (key voseo difference)
  { verb: 'hablar', tense: 'imperativo', mood: 'imperativo', vosForm: 'hablá', tuForm: 'habla', example: 'Hablá más despacio', notes: 'Imperativo vos: drop -r, stress last syllable' },
  { verb: 'comer', tense: 'imperativo', mood: 'imperativo', vosForm: 'comé', tuForm: 'come', example: 'Comé tranquilo' },
  { verb: 'venir', tense: 'imperativo', mood: 'imperativo', vosForm: 'vení', tuForm: 'ven', example: 'Vení para acá' },
  { verb: 'decir', tense: 'imperativo', mood: 'imperativo', vosForm: 'decí', tuForm: 'di', example: 'Decí la verdad' },
  { verb: 'salir', tense: 'imperativo', mood: 'imperativo', vosForm: 'salí', tuForm: 'sal', example: 'Salí de ahí' },
  { verb: 'tener', tense: 'imperativo', mood: 'imperativo', vosForm: 'tené', tuForm: 'ten', example: 'Tené cuidado' },
];

interface PhraseEntry {
  spanish: string;
  english: string;
  category: string;
  difficulty: number;
  context?: string;
  culturalNotes?: string;
  example?: string;
}

export const PHRASES: PhraseEntry[] = [
  // Level 1
  { spanish: '¿Qué onda?', english: "What's up?", category: 'saludos', difficulty: 1, context: 'Informal greeting' },
  { spanish: '¿Cómo andás?', english: 'How are you?', category: 'saludos', difficulty: 1, context: 'Voseo form of ¿cómo andas?' },
  { spanish: 'Dale', english: 'OK / Sure / Go ahead', category: 'expresiones', difficulty: 1, context: 'Extremely common affirmative', culturalNotes: 'Used for agreement, encouragement, goodbye' },
  { spanish: 'Re', english: 'Very / Really', category: 'expresiones', difficulty: 1, context: 'Prefix intensifier: re bueno, re copado', culturalNotes: 'Can also stand alone: -¿Te gustó? -Re.' },
  { spanish: 'Sos groso', english: "You're great / You're awesome", category: 'expresiones', difficulty: 1, context: 'Compliment using voseo' },
  { spanish: 'Ni ahí', english: 'No way / Not at all', category: 'expresiones', difficulty: 1, example: '¿Vas a ir? —Ni ahí' },
  { spanish: 'Buena onda', english: 'Good vibes / Cool', category: 'expresiones', difficulty: 1, context: 'Describes people or situations' },
  { spanish: 'Mala leche', english: 'Bad luck / Mean', category: 'expresiones', difficulty: 1, context: 'Can mean unlucky or ill-intentioned' },

  // Level 2
  { spanish: 'Al toque', english: 'Right away / Immediately', category: 'expresiones', difficulty: 2, example: 'Voy al toque' },
  { spanish: 'De una', english: 'Absolutely / For sure', category: 'expresiones', difficulty: 2, example: '¿Venís? —De una' },
  { spanish: 'Está al pedo', english: "It's useless / He's doing nothing", category: 'expresiones', difficulty: 2, context: 'Vulgar but very common' },
  { spanish: 'Meter la pata', english: 'To put your foot in it / To mess up', category: 'expresiones', difficulty: 2, example: 'Metí la pata con lo que dije' },
  { spanish: 'No me copa', english: "I'm not into it / I don't like it", category: 'opiniones', difficulty: 2, context: 'Informal way to express dislike' },
  { spanish: 'Me cabe', english: "I like it / I'm into it", category: 'opiniones', difficulty: 2, context: 'Slang for me gusta' },
  { spanish: 'Hacé la tuya', english: 'Do your thing / Mind your own business', category: 'expresiones', difficulty: 2 },
  { spanish: 'Es un plomo', english: "He/She/It is boring", category: 'personas', difficulty: 2, context: 'Plomo = lead (heavy metal), metaphor for heavy/boring' },

  // Level 3
  { spanish: 'Tomátela', english: 'Get out of here / Leave', category: 'expresiones', difficulty: 3, context: 'Imperative, can be rude or playful depending on tone' },
  { spanish: 'Está en el horno', english: "He/She is in trouble", category: 'expresiones', difficulty: 3, context: 'Like "in hot water" in English' },
  { spanish: 'Flashear', english: 'To trip out / To imagine things', category: 'acciones', difficulty: 3, example: '¿Estás flasheando? Eso no pasó', context: 'From English "flash"' },
  { spanish: 'Mandar fruta', english: 'To talk nonsense / To wing it', category: 'expresiones', difficulty: 3, example: 'No estudié, mandé fruta en el examen' },
];

interface VesreEntry {
  original: string;
  vesreForm: string;
  meaning?: string;
  example?: string;
}

export const VESRE: VesreEntry[] = [
  { original: 'café', vesreForm: 'feca', meaning: 'coffee', example: 'Vamos a tomar un feca' },
  { original: 'tango', vesreForm: 'gotán', meaning: 'tango (music/dance)', example: 'Escuchamos un gotán re lindo' },
  { original: 'hotel', vesreForm: 'telo', meaning: 'love hotel', example: 'Fueron al telo' },
  { original: 'cabeza', vesreForm: 'zabeca', meaning: 'head / uncouth person', example: 'Ese tipo es un zabeca' },
  { original: 'pancho', vesreForm: 'chopán', meaning: 'hot dog', example: '¿Querés un chopán?' },
  { original: 'pelota', vesreForm: 'lotape', meaning: 'ball / annoyance', example: 'No rompas las lotapes' },
  { original: 'mujer', vesreForm: 'jermu', meaning: 'wife / woman', example: 'Vino con la jermu' },
  { original: 'loco', vesreForm: 'colo', meaning: 'crazy / dude', example: '¿Qué hacés, colo?' },
  { original: 'amigo', vesreForm: 'gomía', meaning: 'friend', example: 'Es mi gomía de toda la vida' },
  { original: 'negro', vesreForm: 'grone', meaning: 'friend (slang, can be offensive)', example: '¿Qué onda, grone?' },
  { original: 'viejo', vesreForm: 'jovie', meaning: 'old / dad', example: 'Mi jovie me llamó' },
  { original: 'ñoqui', vesreForm: 'quiño', meaning: 'person who collects a paycheck without working', example: 'Ese es un quiño en la oficina' },
];

// ── Helpers ─────────────────────────────────────────────────

function esc(str: string): string {
  return str.replace(/'/g, "''");
}
