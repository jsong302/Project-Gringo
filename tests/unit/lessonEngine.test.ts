import { describe, it, expect } from 'vitest';
import {
  parseLlmJson,
  formatDailyLessonBlocks,
  formatLunfardoBlocks,
} from '../../src/services/lessonEngine';
import type { DailyLesson, LunfardoPost } from '../../src/services/lessonEngine';

describe('parseLlmJson', () => {
  it('should parse plain JSON', () => {
    const result = parseLlmJson<{ name: string }>('{"name": "test"}');
    expect(result.name).toBe('test');
  });

  it('should strip markdown code fences', () => {
    const input = '```json\n{"name": "test"}\n```';
    const result = parseLlmJson<{ name: string }>(input);
    expect(result.name).toBe('test');
  });

  it('should strip code fences without language tag', () => {
    const input = '```\n{"value": 42}\n```';
    const result = parseLlmJson<{ value: number }>(input);
    expect(result.value).toBe(42);
  });

  it('should handle whitespace around fences', () => {
    const input = '  ```json\n  {"ok": true}\n  ```  ';
    const result = parseLlmJson<{ ok: boolean }>(input);
    expect(result.ok).toBe(true);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseLlmJson('not json')).toThrow();
  });

  it('should parse arrays', () => {
    const result = parseLlmJson<number[]>('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });
});

describe('formatDailyLessonBlocks', () => {
  const lesson: DailyLesson = {
    title: 'El voseo en presente',
    grammar_topic: 'Cómo conjugar verbos con vos',
    vocabulary: [
      { word: 'laburo', meaning: 'trabajo', example: 'Tengo mucho laburo hoy' },
      { word: 'morfar', meaning: 'comer', example: 'Vamos a morfar algo' },
    ],
    exercise: 'Grabá un audio conjugando el verbo "hablar" con vos.',
    cultural_note: 'En Argentina nadie dice "tú", siempre se usa "vos".',
    difficulty: 2,
  };

  it('should return an array of blocks', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(5);
  });

  it('should start with a header containing the title', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toContain('El voseo en presente');
  });

  it('should include vocabulary section', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('laburo');
    expect(allText).toContain('morfar');
  });

  it('should include exercise section', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Ejercicio');
    expect(allText).toContain('hablar');
  });

  it('should include cultural note', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Dato cultural');
    expect(allText).toContain('vos');
  });

  it('should show difficulty stars', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('⭐⭐');
  });

  it('should include dividers', () => {
    const blocks = formatDailyLessonBlocks(lesson);
    const dividers = blocks.filter((b: any) => b.type === 'divider');
    expect(dividers.length).toBeGreaterThanOrEqual(3);
  });
});

describe('formatLunfardoBlocks', () => {
  const post: LunfardoPost = {
    word: 'laburo',
    meaning_es: 'trabajo',
    meaning_en: 'work/job',
    etymology: 'Del italiano "lavoro"',
    examples: ['Tengo mucho laburo', 'No consigo laburo'],
    vesre: null,
    category: 'trabajo',
  };

  it('should return an array of blocks', () => {
    const blocks = formatLunfardoBlocks(post);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(3);
  });

  it('should start with a header containing the word', () => {
    const blocks = formatLunfardoBlocks(post);
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text.text).toContain('laburo');
  });

  it('should include etymology', () => {
    const blocks = formatLunfardoBlocks(post);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('lavoro');
  });

  it('should include examples', () => {
    const blocks = formatLunfardoBlocks(post);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('Tengo mucho laburo');
    expect(allText).toContain('No consigo laburo');
  });

  it('should include category', () => {
    const blocks = formatLunfardoBlocks(post);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('trabajo');
  });

  it('should show vesre when present', () => {
    const postWithVesre = { ...post, vesre: 'burola' };
    const blocks = formatLunfardoBlocks(postWithVesre);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain('burola');
  });

  it('should not show vesre line when null', () => {
    const blocks = formatLunfardoBlocks(post);
    const allText = JSON.stringify(blocks);
    expect(allText).not.toContain('Vesre');
  });
});
