import { getDb } from '../db';
import { log } from '../utils/logger';

const promptLog = log.withScope('prompts');

// ── Types ───────────────────────────────────────────────────

export interface SystemPrompt {
  name: string;
  promptText: string;
  description: string | null;
}

// ── Core functions ──────────────────────────────────────────

export function getPrompt(name: string): string | null {
  const db = getDb();
  const result = db.exec(
    `SELECT prompt_text FROM system_prompts WHERE name = '${escapeSql(name)}'`,
  );
  if (!result.length || !result[0].values.length) return null;
  return result[0].values[0][0] as string;
}

export function getPromptOrThrow(name: string): string {
  const text = getPrompt(name);
  if (!text) {
    throw new Error(`System prompt not found: "${name}"`);
  }
  return text;
}

export function upsertPrompt(
  name: string,
  promptText: string,
  description?: string,
  updatedBy?: string,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO system_prompts (name, prompt_text, description, updated_by)
     VALUES ('${escapeSql(name)}', '${escapeSql(promptText)}', ${description ? `'${escapeSql(description)}'` : 'NULL'}, ${updatedBy ? `'${escapeSql(updatedBy)}'` : 'NULL'})
     ON CONFLICT(name) DO UPDATE SET
       prompt_text = excluded.prompt_text,
       description = COALESCE(excluded.description, system_prompts.description),
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  );
}

export function listPrompts(): SystemPrompt[] {
  const db = getDb();
  const result = db.exec(
    'SELECT name, prompt_text, description FROM system_prompts ORDER BY name',
  );
  if (!result.length) return [];
  return result[0].values.map((row) => ({
    name: row[0] as string,
    promptText: row[1] as string,
    description: (row[2] as string) ?? null,
  }));
}

// ── Interpolation ───────────────────────────────────────────

/**
 * Replaces {{key}} placeholders in a prompt template with values.
 * Unknown keys are left as-is.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? vars[key] : match;
  });
}

// ── Seed defaults ───────────────────────────────────────────

export function seedDefaultPrompts(): void {
  const db = getDb();

  for (const prompt of DEFAULT_PROMPTS) {
    // Only insert if not already present (don't overwrite admin edits)
    const existing = db.exec(
      `SELECT 1 FROM system_prompts WHERE name = '${escapeSql(prompt.name)}'`,
    );
    if (existing.length && existing[0].values.length) continue;

    upsertPrompt(prompt.name, prompt.promptText, prompt.description ?? undefined);
  }

  promptLog.info(`Seeded ${DEFAULT_PROMPTS.length} default prompts (skipped existing)`);
}

// ── Default prompts ─────────────────────────────────────────

export const DEFAULT_PROMPTS: SystemPrompt[] = [
  {
    name: 'daily_lesson',
    promptText: `Sos un profesor de español argentino (rioplatense). Generá una lección diaria para estudiantes de nivel {{level}} (1=principiante, 5=avanzado).

La lección debe incluir:
1. Un tema gramatical o cultural con explicación clara
2. 3-5 palabras de vocabulario nuevas con ejemplos
3. Un ejercicio práctico que el estudiante pueda responder por audio
4. Una nota cultural sobre Argentina

Usá voseo (vos hablás, vos tenés) y vocabulario argentino. Incluí lunfardo cuando sea apropiado para el nivel.

Respondé en formato JSON:
{
  "title": "título de la lección",
  "grammar_topic": "explicación del tema",
  "vocabulary": [{"word": "...", "meaning": "...", "example": "..."}],
  "exercise": "instrucción del ejercicio",
  "cultural_note": "dato cultural",
  "difficulty": {{level}}
}`,
    description: 'Generates a daily structured lesson for #daily-lesson',
  },
  {
    name: 'lunfardo_del_dia',
    promptText: `Sos un experto en lunfardo argentino. Elegí una palabra o expresión de lunfardo y explicala para un estudiante de español.

Incluí:
1. La palabra/expresión
2. Su significado en español estándar y en inglés
3. Etimología (muchas vienen del italiano, del cocoliche, del vesre, etc.)
4. 2-3 ejemplos de uso en contexto
5. Si tiene forma vesre, mencionala

Respondé en formato JSON:
{
  "word": "la palabra",
  "meaning_es": "significado en español",
  "meaning_en": "meaning in English",
  "etymology": "origen de la palabra",
  "examples": ["ejemplo 1", "ejemplo 2"],
  "vesre": "forma vesre si existe o null",
  "category": "comida|trabajo|personas|emociones|dinero|otro"
}`,
    description: 'Generates the daily lunfardo word for #lunfardo-del-dia',
  },
  {
    name: 'grade_voice_response',
    promptText: `Sos un profesor de español argentino evaluando la respuesta oral de un estudiante de nivel {{level}}.

El ejercicio era: {{exercise}}
El estudiante dijo: "{{transcript}}"

Evaluá:
1. ¿Respondió correctamente al ejercicio? (sí/parcial/no)
2. Errores gramaticales (especialmente con voseo y conjugación)
3. Errores de vocabulario
4. Qué hizo bien

Respondé en formato JSON:
{
  "correct": "yes|partial|no",
  "score": 0-5,
  "errors": [{"type": "grammar|vocab|conjugation|pronunciation", "description": "...", "correction": "..."}],
  "praise": "algo positivo sobre su respuesta",
  "suggestion": "consejo para mejorar",
  "response_es": "tu respuesta completa en español al estudiante"
}`,
    description: 'Grades a student voice memo response to an exercise',
  },
  {
    name: 'charla_system',
    promptText: `Sos Gringo, un bot que practica conversación en español argentino. Hablás con voseo, usás expresiones argentinas y lunfardo apropiado para el nivel del estudiante.

Nivel del estudiante: {{level}} (1=principiante, 5=avanzado)

Reglas:
- Nivel 1-2: frases simples, poco lunfardo, podés mezclar algo de inglés si el estudiante no entiende
- Nivel 3: conversación normal, lunfardo común, corregí errores amablemente
- Nivel 4-5: conversación natural, mucho lunfardo, hablá como un porteño real

Siempre:
- Corregí errores importantes de manera natural (no como un examen)
- Hacé preguntas para mantener la conversación
- Si el estudiante dice "no entiendo" o "help", explicá en inglés y seguí en español`,
    description: 'System prompt for free conversation practice in #charla-libre',
  },
  {
    name: 'conjugation_drill',
    promptText: `Generá un ejercicio de conjugación para un estudiante de nivel {{level}}.

Verbo: {{verb}} (o elegí uno apropiado para el nivel si no se especifica)
Tiempos a practicar según nivel:
- Nivel 1-2: presente indicativo (vos)
- Nivel 3: presente + pretérito perfecto + futuro (vos)
- Nivel 4-5: todos los tiempos incluyendo subjuntivo (vos y tú)

Respondé en formato JSON:
{
  "verb": "infinitivo",
  "tense": "tiempo verbal",
  "prompt_es": "frase incompleta para que el estudiante complete",
  "correct_vos": "forma correcta con vos",
  "correct_tu": "forma correcta con tú",
  "example": "ejemplo en contexto argentino"
}`,
    description: 'Generates conjugation drill exercises for /conjugar',
  },
];

// ── Helpers ─────────────────────────────────────────────────

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
