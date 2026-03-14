/**
 * Curriculum Service — shared curriculum for all users.
 *
 * The curriculum is a linear sequence of ~40 units covering levels 1-5,
 * tailored for an Argentina mission trip group. It's generated once
 * (by LLM or hardcoded fallback) and stored in `curriculum_units`.
 * Admins can view, edit, reorder, add, and archive units.
 */
import { getDb } from '../db';
import { log } from '../utils/logger';

const curLog = log.withScope('curriculum');

// ── Types ───────────────────────────────────────────────────

export interface CurriculumUnit {
  id: number;
  unitOrder: number;
  topic: string;
  title: string;
  description: string | null;
  levelBand: number;
  lessonPrompt: string | null;
  exercisePrompt: string | null;
  passThreshold: number;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

// ── Row mapper ──────────────────────────────────────────────

function rowToUnit(row: any[]): CurriculumUnit {
  return {
    id: row[0] as number,
    unitOrder: row[1] as number,
    topic: row[2] as string,
    title: row[3] as string,
    description: row[4] as string | null,
    levelBand: row[5] as number,
    lessonPrompt: row[6] as string | null,
    exercisePrompt: row[7] as string | null,
    passThreshold: row[8] as number,
    status: row[9] as 'active' | 'archived',
    createdAt: row[10] as string,
    updatedAt: row[11] as string,
  };
}

// ── Read operations ─────────────────────────────────────────

export function getCurriculum(): CurriculumUnit[] {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM curriculum_units WHERE status = 'active' ORDER BY unit_order ASC`,
  );
  if (!result.length) return [];
  return result[0].values.map(rowToUnit);
}

export function getUnit(unitId: number): CurriculumUnit | null {
  const db = getDb();
  const result = db.exec(`SELECT * FROM curriculum_units WHERE id = ${unitId}`);
  if (!result.length || !result[0].values.length) return null;
  return rowToUnit(result[0].values[0]);
}

export function getUnitByOrder(order: number): CurriculumUnit | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM curriculum_units WHERE unit_order = ${order} AND status = 'active'`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToUnit(result[0].values[0]);
}

export function getCurriculumCount(): number {
  const db = getDb();
  const result = db.exec(
    `SELECT COUNT(*) FROM curriculum_units WHERE status = 'active'`,
  );
  return result.length ? (result[0].values[0][0] as number) : 0;
}

export function getFirstUnitForLevel(levelBand: number): CurriculumUnit | null {
  const db = getDb();
  const result = db.exec(
    `SELECT * FROM curriculum_units WHERE level_band = ${levelBand} AND status = 'active' ORDER BY unit_order ASC LIMIT 1`,
  );
  if (!result.length || !result[0].values.length) return null;
  return rowToUnit(result[0].values[0]);
}

// ── Write operations ────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

export function updateUnit(
  unitId: number,
  fields: Partial<Pick<CurriculumUnit, 'topic' | 'title' | 'description' | 'lessonPrompt' | 'exercisePrompt' | 'passThreshold' | 'levelBand'>>,
): void {
  const db = getDb();
  const sets: string[] = [];
  if (fields.topic !== undefined) sets.push(`topic = '${esc(fields.topic)}'`);
  if (fields.title !== undefined) sets.push(`title = '${esc(fields.title)}'`);
  if (fields.description !== undefined) sets.push(fields.description === null ? `description = NULL` : `description = '${esc(fields.description)}'`);
  if (fields.lessonPrompt !== undefined) sets.push(fields.lessonPrompt === null ? `lesson_prompt = NULL` : `lesson_prompt = '${esc(fields.lessonPrompt)}'`);
  if (fields.exercisePrompt !== undefined) sets.push(fields.exercisePrompt === null ? `exercise_prompt = NULL` : `exercise_prompt = '${esc(fields.exercisePrompt)}'`);
  if (fields.passThreshold !== undefined) sets.push(`pass_threshold = ${fields.passThreshold}`);
  if (fields.levelBand !== undefined) sets.push(`level_band = ${fields.levelBand}`);
  if (sets.length === 0) return;
  sets.push(`updated_at = datetime('now')`);
  db.run(`UPDATE curriculum_units SET ${sets.join(', ')} WHERE id = ${unitId}`);
}

export function reorderUnit(unitId: number, newOrder: number): void {
  const db = getDb();
  const unit = getUnit(unitId);
  if (!unit) return;
  const oldOrder = unit.unitOrder;
  if (oldOrder === newOrder) return;

  // Temporarily move the target unit out of the way
  db.run(`UPDATE curriculum_units SET unit_order = -1 WHERE id = ${unitId}`);

  if (newOrder > oldOrder) {
    // Shift down: move each unit one step lower, starting from the lowest
    for (let o = oldOrder + 1; o <= newOrder; o++) {
      db.run(`UPDATE curriculum_units SET unit_order = ${o - 1} WHERE unit_order = ${o}`);
    }
  } else {
    // Shift up: move each unit one step higher, starting from the highest
    for (let o = oldOrder - 1; o >= newOrder; o--) {
      db.run(`UPDATE curriculum_units SET unit_order = ${o + 1} WHERE unit_order = ${o}`);
    }
  }
  db.run(`UPDATE curriculum_units SET unit_order = ${newOrder}, updated_at = datetime('now') WHERE id = ${unitId}`);
}

export function addUnit(
  afterOrder: number,
  data: { topic: string; title: string; description?: string; levelBand: number; lessonPrompt?: string; exercisePrompt?: string },
): number {
  const db = getDb();
  const newOrder = afterOrder + 1;
  // Shift everything after (reverse order to avoid UNIQUE constraint violations)
  const maxResult = db.exec(`SELECT MAX(unit_order) FROM curriculum_units WHERE unit_order >= ${newOrder}`);
  const maxOrder = maxResult[0]?.values[0]?.[0] as number | null;
  if (maxOrder != null) {
    for (let o = maxOrder; o >= newOrder; o--) {
      db.run(`UPDATE curriculum_units SET unit_order = ${o + 1} WHERE unit_order = ${o}`);
    }
  }
  db.run(
    `INSERT INTO curriculum_units (unit_order, topic, title, description, level_band, lesson_prompt, exercise_prompt)
     VALUES (${newOrder}, '${esc(data.topic)}', '${esc(data.title)}',
             ${data.description ? `'${esc(data.description)}'` : 'NULL'},
             ${data.levelBand},
             ${data.lessonPrompt ? `'${esc(data.lessonPrompt)}'` : 'NULL'},
             ${data.exercisePrompt ? `'${esc(data.exercisePrompt)}'` : 'NULL'})`,
  );
  const result = db.exec('SELECT last_insert_rowid()');
  return result[0].values[0][0] as number;
}

export function archiveUnit(unitId: number): void {
  const db = getDb();
  db.run(`UPDATE curriculum_units SET status = 'archived', updated_at = datetime('now') WHERE id = ${unitId}`);
}

export function removeUnit(unitId: number): void {
  const db = getDb();
  const unit = getUnit(unitId);
  if (!unit) return;
  const oldOrder = unit.unitOrder;

  // Delete the unit and related data
  db.run(`DELETE FROM lesson_bank WHERE unit_id = ${unitId}`);
  db.run(`DELETE FROM user_curriculum_progress WHERE unit_id = ${unitId}`);
  db.run(`DELETE FROM curriculum_units WHERE id = ${unitId}`);

  // Compact remaining orders down to fill the gap
  const maxResult = db.exec(`SELECT MAX(unit_order) FROM curriculum_units`);
  const maxOrder = maxResult[0]?.values[0]?.[0] as number | null;
  if (maxOrder != null) {
    for (let o = oldOrder + 1; o <= maxOrder; o++) {
      db.run(`UPDATE curriculum_units SET unit_order = ${o - 1} WHERE unit_order = ${o}`);
    }
  }
}

// ── Seeding ─────────────────────────────────────────────────

/**
 * Seed the curriculum with the hardcoded fallback if the table is empty.
 * Called during app boot.
 */
/**
 * Ensure the "How Spanish Verbs Work" unit exists (added after initial seed).
 * Inserts at position 3 if missing, shifting existing units.
 */
export function ensureVerbBasicsUnit(): void {
  const db = getDb();
  const result = db.exec(`SELECT id FROM curriculum_units WHERE topic = 'verb_basics' AND status = 'active'`);
  if (result.length && result[0].values.length) {
    return; // already exists
  }

  const count = getCurriculumCount();
  if (count === 0) return; // seed will handle it

  curLog.info('Inserting "How Spanish Verbs Work" unit at position 3...');
  addUnit(2, {
    topic: 'verb_basics',
    title: 'How Spanish Verbs Work',
    description: 'What conjugation is, infinitives (-ar/-er/-ir), subject pronouns (yo, vos, él/ella, nosotros, ellos). The foundation before learning any verb tenses.',
    levelBand: 1,
    lessonPrompt: 'Teach the absolute basics of how Spanish verbs work — assume the student has NEVER heard the word "conjugation" before. Cover: 1) In English we say "I speak / he speaks" — the verb changes a little. Spanish does this MORE. That\'s conjugation. 2) Spanish verbs come in three flavors: -ar (hablar = to speak), -er (comer = to eat), -ir (vivir = to live). The base form is called the "infinitive." 3) Subject pronouns: yo (I), vos (you — Argentine), él/ella (he/she), nosotros (we), ellos/ellas (they). Note: Argentina uses "vos" instead of "tú". 4) Show ONE simple example of how hablar changes: yo hablo, vos hablás, él habla. Don\'t teach full conjugation tables yet — just plant the concept. Keep it light and encouraging: "This is the #1 thing that makes Spanish different from English, and once you get it, everything clicks."',
    exercisePrompt: 'Simple matching exercise: give 5 infinitives (hablar, comer, vivir, tomar, escribir) and ask the student to write what each means in English. Then give 3 sentences with "yo ___" and ask them to pick the right verb from a word bank. Keep it very easy — this is just concept familiarity, not conjugation mastery.',
  });
  curLog.info('Inserted "How Spanish Verbs Work" unit');
}

/**
 * Sync lesson/exercise prompts from DEFAULT_CURRICULUM to existing units.
 * Runs on every boot — updates units whose prompts have changed in code.
 */
export function syncCurriculumPrompts(): void {
  const db = getDb();
  let updated = 0;

  for (const seed of DEFAULT_CURRICULUM) {
    if (!seed.lessonPrompt && !seed.exercisePrompt) continue;

    const result = db.exec(
      `SELECT id, lesson_prompt, exercise_prompt FROM curriculum_units WHERE topic = '${esc(seed.topic)}' AND status = 'active'`,
    );
    if (!result.length || !result[0].values.length) continue;

    const [id, currentLesson, currentExercise] = result[0].values[0] as [number, string | null, string | null];
    const changes: string[] = [];

    if (seed.lessonPrompt && seed.lessonPrompt !== currentLesson) {
      changes.push(`lesson_prompt = '${esc(seed.lessonPrompt)}'`);
    }
    if (seed.exercisePrompt && seed.exercisePrompt !== currentExercise) {
      changes.push(`exercise_prompt = '${esc(seed.exercisePrompt)}'`);
    }

    if (changes.length > 0) {
      db.run(`UPDATE curriculum_units SET ${changes.join(', ')} WHERE id = ${id}`);
      updated++;
    }
  }

  if (updated > 0) {
    curLog.info(`Synced prompts for ${updated} curriculum unit(s)`);
  }
}

export function seedCurriculumIfEmpty(): void {
  const count = getCurriculumCount();
  if (count > 0) {
    curLog.info(`Curriculum already has ${count} units — skipping seed`);
    return;
  }

  curLog.info('Seeding default curriculum (41 units)...');
  const db = getDb();

  for (const unit of DEFAULT_CURRICULUM) {
    db.run(
      `INSERT INTO curriculum_units (unit_order, topic, title, description, level_band, lesson_prompt, exercise_prompt)
       VALUES (${unit.order}, '${esc(unit.topic)}', '${esc(unit.title)}',
               '${esc(unit.description)}', ${unit.levelBand},
               ${unit.lessonPrompt ? `'${esc(unit.lessonPrompt)}'` : 'NULL'},
               ${unit.exercisePrompt ? `'${esc(unit.exercisePrompt)}'` : 'NULL'})`,
    );
  }

  curLog.info(`Seeded ${DEFAULT_CURRICULUM.length} curriculum units`);
}

// ── Default curriculum ──────────────────────────────────────

interface DefaultUnit {
  order: number;
  topic: string;
  title: string;
  description: string;
  levelBand: number;
  lessonPrompt: string | null;
  exercisePrompt: string | null;
}

const DEFAULT_CURRICULUM: DefaultUnit[] = [
  // ── Level 1: Survival Basics (Units 1-11) ──
  {
    order: 1, topic: 'greetings', title: 'Greetings & Introductions', levelBand: 1,
    description: 'Hola, ¿cómo andás?, me llamo..., soy de... Basic greetings and introductions in Argentine style.',
    lessonPrompt: 'Teach basic Argentine greetings: hola, ¿cómo andás?, ¿todo bien?, me llamo..., soy de... Include the cheek-kiss greeting culture. Keep it simple for absolute beginners.',
    exercisePrompt: 'Ask the student to introduce themselves in Spanish: their name, where they are from, and a greeting. Grade leniently — any attempt at Spanish is good.',
  },
  {
    order: 2, topic: 'numbers_questions', title: 'Numbers & Basic Questions', levelBand: 1,
    description: 'Numbers 1-100, ¿cuánto?, ¿dónde?, ¿qué?, ¿cómo? Essential question words.',
    lessonPrompt: 'Teach numbers 1-100 and basic question words: ¿cuánto?, ¿dónde?, ¿qué?, ¿cómo?, ¿cuándo?, ¿quién? Include practical examples like asking prices and directions.',
    exercisePrompt: 'Give the student 3 simple questions to translate to Spanish, involving numbers and question words. E.g. "How much does it cost?", "Where is the bathroom?", "What is your name?"',
  },
  {
    order: 3, topic: 'verb_basics', title: 'How Spanish Verbs Work', levelBand: 1,
    description: 'What conjugation is, infinitives (-ar/-er/-ir), subject pronouns (yo, vos, él/ella, nosotros, ellos). The foundation before learning any verb tenses.',
    lessonPrompt: 'Teach the absolute basics of how Spanish verbs work — assume the student has NEVER heard the word "conjugation" before. Cover: 1) In English we say "I speak / he speaks" — the verb changes a little. Spanish does this MORE. That\'s conjugation. 2) Spanish verbs come in three flavors: -ar (hablar = to speak), -er (comer = to eat), -ir (vivir = to live). The base form is called the "infinitive." 3) Subject pronouns: yo (I), vos (you — Argentine), él/ella (he/she), nosotros (we), ellos/ellas (they). Note: Argentina uses "vos" instead of "tú". 4) Show ONE simple example of how hablar changes: yo hablo, vos hablás, él habla. Don\'t teach full conjugation tables yet — just plant the concept. Keep it light and encouraging: "This is the #1 thing that makes Spanish different from English, and once you get it, everything clicks."',
    exercisePrompt: 'Simple matching exercise: give 5 infinitives (hablar, comer, vivir, tomar, escribir) and ask the student to write what each means in English. Then give 3 sentences with "yo ___" and ask them to pick the right verb from a word bank. Keep it very easy — this is just concept familiarity, not conjugation mastery.',
  },
  {
    order: 4, topic: 'ser_estar', title: 'Ser vs Estar', levelBand: 1,
    description: 'Identity vs state/location. Soy americano, estoy en Buenos Aires, estoy cansado.',
    lessonPrompt: 'Teach the difference between ser (identity, origin, profession) and estar (location, feelings, temporary states). IMPORTANT: Show the full present-tense conjugation for BOTH verbs (yo, vos, él/ella, nosotros, ellos) before using any conjugated forms in examples. Students need to see the full conjugation table so they know where "soy", "sos", "estoy", "estás" come from. Then give Argentine examples: Soy de Nueva York, Estoy en Buenos Aires, Estoy re cansado.',
    exercisePrompt: 'Give 5 fill-in-the-blank sentences where the student chooses ser or estar. Mix identity, location, and temporary states.',
  },
  {
    order: 5, topic: 'present_tense', title: 'Present Tense (Regular Verbs)', levelBand: 1,
    description: '-ar/-er/-ir verb conjugation. Daily actions: hablar, comer, vivir.',
    lessonPrompt: 'Teach regular present tense conjugation for -ar (hablar), -er (comer), -ir (vivir). Show the FULL conjugation table for each verb type (yo, vos, él/ella, nosotros, ellos) — this is their first real conjugation table, so make it clear and organized. Focus on yo, vos, él/ella forms as the most useful in conversation, but show all forms so students see the pattern. Mention that Argentine Spanish uses "vos" instead of "tú" and that vos has its own special endings (hablás, comés, vivís).',
    exercisePrompt: 'Ask the student to conjugate 3 regular verbs in present tense for yo, vos, and él/ella forms. Then ask them to write 2 sentences about their daily routine.',
  },
  {
    order: 6, topic: 'food_ordering', title: 'Food & Ordering', levelBand: 1,
    description: 'Restaurant vocab: quiero un café, la cuenta, empanadas, asado, facturas.',
    lessonPrompt: 'Teach food and restaurant vocabulary: ordering (quiero..., me traés..., la cuenta por favor), key Argentine foods (empanadas, asado, milanesa, facturas, dulce de leche, mate). Include typical restaurant interactions.',
    exercisePrompt: 'Role-play: the student is at a restaurant in Buenos Aires. Ask them to order a meal, ask about ingredients, and request the check. Provide a simple menu context.',
  },
  {
    order: 7, topic: 'getting_around', title: 'Getting Around', levelBand: 1,
    description: 'Directions, transportation: subte, colectivo, ¿dónde queda...?, derecha/izquierda.',
    lessonPrompt: 'Teach directions and transportation: ¿dónde queda...?, derecha, izquierda, derecho, una cuadra, subte (subway), colectivo (bus), remís/taxi. Include asking for and giving directions.',
    exercisePrompt: 'Ask the student to give directions from a plaza to a church (iglesia), using at least 3 direction words. Then ask them to ask how to get to the bus stop.',
  },
  {
    order: 8, topic: 'family', title: 'Family & Relationships', levelBand: 1,
    description: 'Family vocab: mi familia, hermano/a, padre/madre. Introducing others.',
    lessonPrompt: 'Teach family vocabulary: padre/madre (papá/mamá), hermano/a, hijo/a, abuelo/a, tío/a, primo/a. Include how to introduce family members: Te presento a mi hermano, Él es mi padre.',
    exercisePrompt: 'Ask the student to describe their family in 3-4 sentences. Who is in their family? What are their names?',
  },
  {
    order: 9, topic: 'time_schedule', title: 'Time & Schedule', levelBand: 1,
    description: '¿Qué hora es?, days of the week, making plans: nos vemos a las...',
    lessonPrompt: 'Teach telling time: ¿Qué hora es?, Son las tres, A las ocho de la mañana. Days of the week, months. Making plans: ¿A qué hora nos vemos?, Nos juntamos el viernes.',
    exercisePrompt: 'Ask the student to write out their schedule for tomorrow: what time they wake up, eat meals, and when they are free to meet. Use time expressions.',
  },
  {
    order: 10, topic: 'shopping_money', title: 'Shopping & Money', levelBand: 1,
    description: 'Pesos, ¿cuánto sale?, bargaining basics, numbers in context.',
    lessonPrompt: 'Teach shopping vocabulary: ¿Cuánto sale?, ¿Tenés cambio?, Es muy caro, ¿Me hacés un descuento? Numbers in context (prices). Argentine peso basics. Feria (market) vs shopping (mall) culture.',
    exercisePrompt: 'Role-play: the student is at a feria buying souvenirs. Ask them to ask prices, negotiate, and pay for 2 items. Provide prices in pesos.',
  },
  {
    order: 11, topic: 'review_1', title: 'Level 1 Review & Consolidation', levelBand: 1,
    description: 'Mixed exercises from units 1-9. Demonstrate survival-level Spanish.',
    lessonPrompt: 'Review all Level 1 topics: greetings, numbers, ser/estar, present tense, food, directions, family, time, shopping. Highlight common mistakes and reinforce key patterns.',
    exercisePrompt: 'Give the student a mini scenario: They just arrived in Buenos Aires. Ask them to: 1) Greet someone and introduce themselves, 2) Ask for directions to a restaurant, 3) Order a meal. All in one connected response.',
  },

  // ── Level 2: Conversational Foundations (Units 12-21) ──
  {
    order: 12, topic: 'voseo', title: 'Voseo Introduction', levelBand: 2,
    description: 'Vos hablás, vos tenés, vos podés — the Argentine "you" in all common verbs.',
    lessonPrompt: 'Deep dive into voseo: conjugation pattern (stress on last syllable: hablás, comés, vivís). Common irregular vos forms: sos (ser), tenés, podés, querés, venís, decís. Contrast with tú forms. This is essential for sounding Argentine.',
    exercisePrompt: 'Convert 5 sentences from tú to vos form. Then write 3 original sentences using vos with irregular verbs.',
  },
  {
    order: 13, topic: 'past_preterite', title: 'Past Tense (Pretérito)', levelBand: 2,
    description: 'Ayer fui, comí, hablé — talking about completed past actions.',
    lessonPrompt: 'Teach pretérito (simple past): regular -ar (hablé), -er (comí), -ir (viví) conjugations. Key irregulars: fui/fue (ir/ser), tuve, hice, dije, pude. Use for telling what happened yesterday, last weekend.',
    exercisePrompt: 'Ask the student to tell you what they did yesterday, using at least 5 different past tense verbs. Then give 3 sentences to translate that use irregular past tense verbs.',
  },
  {
    order: 14, topic: 'describing', title: 'Describing People & Places', levelBand: 2,
    description: 'Adjectives, agreement, comparisons. Buenos Aires landmarks and neighborhoods.',
    lessonPrompt: 'Teach adjective agreement (masculino/femenino, singular/plural), common descriptive adjectives, comparisons (más...que, menos...que, tan...como). Include Buenos Aires landmarks: La Boca, San Telmo, Recoleta, el Obelisco.',
    exercisePrompt: 'Ask the student to describe 2 things: 1) A person they know (physical and personality), 2) A place they like. Use at least 5 adjectives total with correct agreement.',
  },
  {
    order: 15, topic: 'weather_smalltalk', title: 'Weather & Small Talk', levelBand: 2,
    description: 'Hace frío/calor, llueve. Small talk patterns for building rapport.',
    lessonPrompt: 'Teach weather expressions: hace frío/calor/viento, llueve, está nublado, está lindo. Small talk patterns: ¿Qué onda?, ¿Cómo te va?, Todo tranqui, Anda todo bien. Argentine small talk culture.',
    exercisePrompt: 'Write a short small talk conversation (4-6 exchanges) between the student and a new Argentine friend. Include weather, how they are doing, and what they plan to do.',
  },
  {
    order: 16, topic: 'faith_basics', title: 'At the Church', levelBand: 2,
    description: 'Fe, oración, iglesia, Dios, culto — basic ministry vocabulary.',
    lessonPrompt: 'Teach basic faith/church vocabulary: Dios (God), Jesús, fe (faith), oración (prayer), iglesia (church), culto/servicio (service), pastor, hermano/a (brother/sister in faith), alabanza (worship), Biblia. Phrases: Vamos a orar, Dios te bendiga, Estamos orando por vos.',
    exercisePrompt: 'Ask the student to: 1) Invite someone to church in Spanish, 2) Tell someone they are praying for them, 3) Describe what happens at a church service using at least 3 faith vocabulary words.',
  },
  {
    order: 17, topic: 'feelings', title: 'Feelings & Emotions', levelBand: 2,
    description: 'Estoy contento/cansado/preocupado, ¿cómo te sentís? Emotional vocabulary.',
    lessonPrompt: 'Teach emotion vocabulary with estar: contento/a, triste, cansado/a, preocupado/a, enojado/a, nervioso/a, emocionado/a. Argentine expressions: Estoy re contento, Me siento bárbaro, Estoy hecho/a bolsa (exhausted). ¿Cómo te sentís?',
    exercisePrompt: 'Ask the student to describe how they feel in 3 different situations: 1) After a long flight to Argentina, 2) Meeting their host family, 3) Before giving a testimony at church.',
  },
  {
    order: 18, topic: 'phone_messaging', title: 'Phone & Messaging', levelBand: 2,
    description: 'Mandame un mensaje, llamar, WhatsApp culture in Argentina.',
    lessonPrompt: 'Teach phone/messaging vocabulary: Mandame un mensaje (text me), Te llamo después, ¿Me pasás tu número?, WhatsApp voice notes culture. Argentine texting abbreviations: q = que, x = por, tkm = te quiero mucho.',
    exercisePrompt: 'Write 3 WhatsApp messages: 1) Ask a friend to meet up tomorrow, 2) Cancel plans politely, 3) Share that something exciting happened. Use informal Argentine style.',
  },
  {
    order: 19, topic: 'health_emergencies', title: 'Health & Emergencies', levelBand: 2,
    description: 'Me duele..., necesito un médico, farmacia, emergencies vocabulary.',
    lessonPrompt: 'Teach health vocabulary: Me duele la cabeza/el estómago, Necesito un médico, farmacia, hospital, emergencia. Body parts. Common ailments. Key phrases: No me siento bien, ¿Tenés algo para el dolor de cabeza?',
    exercisePrompt: 'Role-play: the student is feeling sick in Buenos Aires. Ask them to: 1) Describe their symptoms, 2) Ask for help finding a pharmacy, 3) Ask the pharmacist for medicine.',
  },
  {
    order: 20, topic: 'imperfect', title: 'Imperfect Tense', levelBand: 2,
    description: 'Cuando era chico..., habitual past actions and descriptions.',
    lessonPrompt: 'Teach the imperfect tense: -ar (hablaba), -er (comía), -ir (vivía). Irregulars: era, iba, veía. Use for habitual past actions (Siempre iba a la iglesia), descriptions (Era un día lindo), and ongoing states (Tenía hambre). Contrast with pretérito.',
    exercisePrompt: 'Ask the student to write about their childhood using the imperfect: where they lived, what they used to do, what their family was like. At least 5 sentences with imperfect verbs.',
  },
  {
    order: 21, topic: 'review_2', title: 'Level 2 Review & Real Conversations', levelBand: 2,
    description: 'Dialogue practice combining voseo, past tenses, feelings, and faith vocab.',
    lessonPrompt: 'Review Level 2: voseo, pretérito, imperfect, descriptions, feelings, faith vocabulary. Focus on putting it all together in natural conversation.',
    exercisePrompt: 'Write a conversation (6-8 exchanges) between the student and an Argentine church member. The conversation should: use voseo, include past tense (what they did today), express feelings, and mention church/faith. Make it natural and warm.',
  },

  // ── Level 3: Intermediate Expression (Units 22-31) ──
  {
    order: 22, topic: 'lunfardo_basics', title: 'Lunfardo Basics', levelBand: 3,
    description: 'Laburo, guita, pibe/piba, morfar, birra — essential Argentine slang.',
    lessonPrompt: 'Introduce lunfardo (Buenos Aires slang): laburo (work), guita (money), pibe/piba (guy/girl), morfar (eat), birra (beer), afanar (steal), mina (woman), chabón (dude), bondi (bus), re- prefix (re lindo = really nice). Etymology: many come from Italian immigration.',
    exercisePrompt: 'Rewrite 5 standard Spanish sentences using lunfardo. Then write a short paragraph describing your day using at least 4 lunfardo words naturally.',
  },
  {
    order: 23, topic: 'subjunctive_intro', title: 'Subjunctive Introduction', levelBand: 3,
    description: 'Quiero que vengas, espero que estés bien — expressing wishes and hopes.',
    lessonPrompt: 'Introduce the present subjunctive: formation from yo present → change ending. Common triggers: quiero que, espero que, ojalá, es importante que. Focus on practical phrases: Espero que estés bien, Quiero que vengas, Ojalá que llueva.',
    exercisePrompt: 'Complete 4 sentences using the subjunctive. Then write 3 original sentences expressing wishes or hopes about the mission trip, using subjunctive.',
  },
  {
    order: 24, topic: 'sharing_faith', title: 'Sharing Your Faith', levelBand: 3,
    description: 'Testimony vocab: creo que..., Dios me ayudó, mi vida cambió.',
    lessonPrompt: 'Teach testimony/faith-sharing vocabulary: Creo en Dios, Jesús cambió mi vida, Antes yo era..., Dios me ayudó cuando..., Mi fe es importante porque..., ¿Puedo orar por vos?, Dios tiene un plan para tu vida. How to share a simple testimony structure: before, encounter, after.',
    exercisePrompt: 'Ask the student to write a short testimony (5-8 sentences): what their life was like before faith, what changed, and what their life is like now. Use past and present tenses, and faith vocabulary.',
  },
  {
    order: 25, topic: 'opinions', title: 'Opinions & Debate', levelBand: 3,
    description: 'Me parece que..., no estoy de acuerdo, para mí... Argentine directness.',
    lessonPrompt: 'Teach expressing opinions: Me parece que..., Para mí..., Creo que..., No estoy de acuerdo, Tenés razón, Puede ser pero... Argentine debate culture: direct but warm. Useful connectors: sin embargo, por otro lado, además.',
    exercisePrompt: 'Give the student a topic (e.g., "Is it better to live in a big city or small town?") and ask them to write their opinion using at least 3 opinion expressions and one counterargument.',
  },
  {
    order: 26, topic: 'argentine_culture', title: 'Argentine Culture', levelBand: 3,
    description: 'Mate, asado rituals, fútbol, tango, sobremesa — cultural fluency.',
    lessonPrompt: 'Teach cultural concepts: mate (ritual, never say thank you unless done), asado (Sunday tradition, roles), sobremesa (lingering after meals), fútbol passion, tango history, Argentine identity. Cultural do/donts for visitors.',
    exercisePrompt: 'Ask the student to explain Argentine mate culture to a friend who has never heard of it. Then describe what a typical Sunday asado is like. Use at least 5 cultural vocabulary words.',
  },
  {
    order: 27, topic: 'narrating', title: 'Narrating Events', levelBand: 3,
    description: 'Telling stories with sequencing: primero, después, de repente, al final.',
    lessonPrompt: 'Teach narrative structure and sequencing: primero, después, luego, entonces, de repente, mientras, por eso, al final, por último. Combining pretérito (actions) with imperfect (descriptions/background). Story-telling as an Argentine social skill.',
    exercisePrompt: 'Ask the student to tell a story about something that happened to them (real or made up). Must use: at least 4 sequencing words, mix of pretérito and imperfect, and be at least 8 sentences long.',
  },
  {
    order: 28, topic: 'conditional', title: 'Conditional Tense', levelBand: 3,
    description: 'Si pudiera..., me gustaría..., ¿qué harías? Hypotheticals.',
    lessonPrompt: 'Teach the conditional tense: hablaría, comería, viviría. Irregulars: tendría, haría, diría, podría, saldría. Si clauses (simple): Si tuviera tiempo, viajaría más. Me gustaría + infinitive. Useful for polite requests and hypotheticals.',
    exercisePrompt: 'Answer these hypothetical questions in full sentences: 1) Si pudieras vivir en cualquier país, ¿dónde vivirías? 2) ¿Qué harías con un millón de dólares? 3) Si fueras pastor, ¿qué le dirías a tu congregación?',
  },
  {
    order: 29, topic: 'youth_slang', title: 'Slang & Youth Language', levelBand: 3,
    description: 'Copado, flashear, re-, onda, buena onda, malísimo — modern Argentine slang.',
    lessonPrompt: 'Teach modern Argentine youth slang: copado (cool), flashear (to trip out/exaggerate), buena/mala onda (good/bad vibes), bardear (to cause trouble/disrespect), gastar (to tease), posta (for real), onda (vibe), malísimo, genial. The re- intensifier: re copado, re lindo, re piola.',
    exercisePrompt: 'Rewrite a boring paragraph about your weekend into something a young Argentine would say, using at least 5 slang expressions. Make it sound natural, not forced.',
  },
  {
    order: 30, topic: 'prayer_worship', title: 'Prayer & Worship', levelBand: 3,
    description: 'Orar, alabar, bendición — leading prayer and worship in Spanish.',
    lessonPrompt: 'Teach prayer and worship vocabulary: Señor/Padre Dios, te alabamos, te damos gracias, bendecinos, guianos, perdónanos, amén. Worship phrases: Gloria a Dios, Santo es el Señor. How to lead a simple group prayer. Useful transition phrases for prayer.',
    exercisePrompt: 'Write a short prayer (6-8 sentences) that could be used to open a church service or small group meeting. Include: praise, thanksgiving, a request, and a blessing. Use appropriate formal/reverent Spanish.',
  },
  {
    order: 31, topic: 'review_3', title: 'Level 3 Review & Storytelling', levelBand: 3,
    description: 'Tell a complete story using lunfardo, subjunctive, conditional, and faith vocab.',
    lessonPrompt: 'Review Level 3: lunfardo, subjunctive, testimony, opinions, culture, narrating, conditional, slang, prayer. Focus on fluency and natural expression.',
    exercisePrompt: 'Tell a story about a meaningful experience during a (real or imagined) mission trip to Argentina. Use: lunfardo, past tenses, conditional (what you would do differently), faith vocabulary, and narrative sequencing. At least 10 sentences.',
  },

  // ── Level 4: Advanced Fluency (Units 32-41) ──
  {
    order: 32, topic: 'vesre', title: 'Vesre (Word Reversal)', levelBand: 4,
    description: 'Feca=café, garpa=pagar, gotán=tango — Argentine word play.',
    lessonPrompt: 'Teach vesre (syllable reversal slang): feca (café), garpa (pagar), gotán (tango), jermu (mujer), dorima (marido), zabeca (cabeza), lorca (calor), toga (gato). History: from Italian immigrants, unique to Buenos Aires. Used casually among friends.',
    exercisePrompt: 'Decode 5 vesre words into standard Spanish, then use 3 of them in natural sentences. Write a short dialogue between two friends using at least 2 vesre words.',
  },
  {
    order: 33, topic: 'past_subjunctive', title: 'Complex Subjunctive', levelBand: 4,
    description: 'Si hubiera sabido..., ojalá hubiera... Past subjunctive and compound tenses.',
    lessonPrompt: 'Teach past subjunctive: -ara/-iera forms (hablara/comiera). Si hubiera + past participle: Si hubiera sabido, habría ido. Ojalá + past subjunctive for impossible wishes. Useful for expressing regret, hypothetical past scenarios.',
    exercisePrompt: 'Write 4 sentences about things you wish had been different, using past subjunctive. Then respond to a hypothetical: "Si hubieras nacido en Argentina, ¿cómo habría sido tu vida?"',
  },
  {
    order: 34, topic: 'humor_irony', title: 'Argentine Humor & Irony', levelBand: 4,
    description: 'Sarcasm patterns, understatement, self-deprecating humor, "no es tan grave".',
    lessonPrompt: 'Teach Argentine humor patterns: understatement (No es tan grave = it IS grave), sarcasm with tone (¡Qué bien! meaning the opposite), self-deprecating humor, exaggeration for effect. The role of humor in Argentine social bonding. Common humorous expressions and when they are appropriate.',
    exercisePrompt: 'Read 3 Argentine-style jokes or ironic statements and explain what they really mean. Then write 2 humorous/ironic responses to everyday situations (e.g., your bus is 30 minutes late, it starts raining on your only free day).',
  },
  {
    order: 35, topic: 'pastoral_care', title: 'Pastoral Conversations', levelBand: 4,
    description: 'Counseling vocab: ¿cómo puedo ayudarte?, te escucho, active listening phrases.',
    lessonPrompt: 'Teach pastoral/counseling vocabulary: ¿Cómo puedo ayudarte?, Te escucho, Contame lo que te pasa, No estás solo/a, Dios está con vos, Vamos a orar juntos. Active listening phrases: Entiendo, Debe ser difícil, ¿Cómo te hace sentir eso? Sensitivity and cultural awareness in pastoral care.',
    exercisePrompt: 'Role-play: someone comes to you upset about a family problem. Write a pastoral conversation (8-10 exchanges) where you listen, empathize, offer comfort using faith, and pray together. Use appropriate vocabulary and tone.',
  },
  {
    order: 36, topic: 'idioms', title: 'Idioms & Refranes', levelBand: 4,
    description: 'Al que madruga Dios lo ayuda, no hay mal que por bien no venga — proverbs and fixed expressions.',
    lessonPrompt: 'Teach common Argentine/Spanish idioms and refranes: Al que madruga Dios lo ayuda, No hay mal que por bien no venga, Meter la pata, Estar al horno, Tomar el pelo, Hacerse el boludo, Quedar como un campeón, Estar en la lona. When and how to use them naturally.',
    exercisePrompt: 'Match 5 idioms to their meanings, then use 3 of them in original sentences that show you understand their context. Describe a situation where you might use "estar al horno".',
  },
  {
    order: 37, topic: 'social_topics', title: 'Social & Current Topics', levelBand: 4,
    description: 'Understanding barrio culture, social issues, community life in Argentina.',
    lessonPrompt: 'Teach vocabulary for discussing social topics: barrio (neighborhood), comunidad (community), ayudar, servir, necesidad, pobreza, esperanza, solidaridad. Argentine social concepts: villa (informal settlement), merendero (community kitchen), solidarity culture. How to discuss social realities respectfully.',
    exercisePrompt: 'Write about a social issue you care about and how your mission trip group could help address it in an Argentine community. Use at least 5 social/community vocabulary words. Express both the problem and hope.',
  },
  {
    order: 38, topic: 'advanced_lunfardo', title: 'Advanced Lunfardo', levelBand: 4,
    description: 'Afanar, mango, bardear, rescatarse, piola — deeper slang for real conversations.',
    lessonPrompt: 'Advanced lunfardo: afanar (steal/hustle), mango (peso/money), bardear (disrespect/cause trouble), rescatarse (to chill/back off), piola (cool/clever), chamuyar (to sweet-talk/BS), ortiva (snitch/killjoy), fiaca (laziness), bancar (to support/stand). Register awareness: when lunfardo is appropriate vs. too informal.',
    exercisePrompt: 'Write two versions of the same story: one in standard Spanish, one using natural lunfardo. The story: you went out with friends, had a great time, but something went wrong at the end.',
  },
  {
    order: 39, topic: 'bible_study', title: 'Leading a Bible Study', levelBand: 4,
    description: 'Teaching vocab: explicar, compartir, reflexionar, versículo, pasaje.',
    lessonPrompt: 'Teach Bible study leadership vocabulary: versículo (verse), pasaje (passage), reflexionar (reflect), compartir (share), orar (pray), explicar (explain), aplicar (apply), enseñanza (teaching), contexto, mensaje. Phrases for leading: Abramos la Biblia en..., ¿Qué les parece este pasaje?, Reflexionemos juntos.',
    exercisePrompt: 'Prepare a mini Bible study introduction in Spanish: 1) Welcome the group, 2) Introduce the passage (pick any), 3) Ask 2 discussion questions, 4) Close with a brief prayer. Write it as you would actually say it.',
  },
  {
    order: 40, topic: 'native_speed', title: 'Native-Speed Comprehension', levelBand: 4,
    description: 'Fast speech patterns, elision, porteño accent features, connected speech.',
    lessonPrompt: 'Teach features of fast/native Argentine speech: elision (para = pa, vamos a = vamo a), the sh sound for ll/y (calle = cashe), aspiration of s, connected speech patterns. How to parse rapid speech. Common contractions and shortcuts in spoken Argentine Spanish.',
    exercisePrompt: 'Rewrite 5 formal sentences as they would sound in casual, fast Argentine speech (with elisions and shortcuts). Then explain what these rapid-speech phrases mean: "Vamo a tomar algo", "¿Qué onda, todo piola?", "Dale, nos vemo mañana".',
  },
  {
    order: 41, topic: 'review_final', title: 'Final Review & Graduation', levelBand: 4,
    description: 'Comprehensive assessment: conversation, lunfardo, faith, culture, grammar.',
    lessonPrompt: 'Final review covering all levels: basic survival, voseo, past tenses, subjunctive, conditional, lunfardo, vesre, faith vocabulary, cultural knowledge, pastoral care. Celebrate the student\'s journey from beginner to advanced.',
    exercisePrompt: 'Comprehensive exercise: 1) Write a testimony in Spanish using advanced grammar (8+ sentences), 2) Translate 3 lunfardo-heavy sentences to standard Spanish, 3) Lead a mock Bible study opening (4 sentences), 4) Describe what you are most excited about for the Argentina trip using conditional and subjunctive.',
  },
];
