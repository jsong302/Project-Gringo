import { describe, it, expect } from 'vitest';
import { parseGradeResponse, formatGradeFeedbackBlocks } from '../../src/services/reviewGrader';
import type { GradeResult } from '../../src/services/reviewGrader';

describe('parseGradeResponse', () => {
  it('should parse a correct response', () => {
    const json = JSON.stringify({
      correct: 'yes',
      score: 5,
      errors: [],
      praise: 'Excelente pronunciación!',
      suggestion: 'Seguí practicando',
      response_es: 'Muy bien, hablás como un porteño!',
    });

    const result = parseGradeResponse(json);
    expect(result.quality).toBe(5);
    expect(result.correct).toBe('yes');
    expect(result.errors).toHaveLength(0);
    expect(result.praise).toBe('Excelente pronunciación!');
    expect(result.responseEs).toContain('porteño');
  });

  it('should parse a partial response with errors', () => {
    const json = JSON.stringify({
      correct: 'partial',
      score: 3,
      errors: [
        { type: 'conjugation', description: 'Usaste tú en vez de vos', correction: 'hablás en vez de hablas' },
        { type: 'vocab', description: 'Usaste "cool" en vez de lunfardo', correction: 'Decí "copado" en vez de "cool"' },
      ],
      praise: 'Buen intento!',
      suggestion: 'Practicá más el voseo',
      response_es: 'Casi, pero recordá usar vos.',
    });

    const result = parseGradeResponse(json);
    expect(result.quality).toBe(3);
    expect(result.correct).toBe('partial');
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].type).toBe('conjugation');
    expect(result.errors[1].type).toBe('vocab');
  });

  it('should parse an incorrect response', () => {
    const json = JSON.stringify({
      correct: 'no',
      score: 1,
      errors: [{ type: 'grammar', description: 'Respuesta incorrecta', correction: 'La respuesta correcta es...' }],
      praise: 'No te preocupes, seguí intentando',
      suggestion: 'Repasá este tema',
      response_es: 'La respuesta correcta era otra.',
    });

    const result = parseGradeResponse(json);
    expect(result.quality).toBe(1);
    expect(result.correct).toBe('no');
  });

  it('should handle Spanish-language correct values', () => {
    expect(parseGradeResponse(JSON.stringify({ correct: 'sí', score: 5, errors: [], praise: '', suggestion: '', response_es: '' })).correct).toBe('yes');
    expect(parseGradeResponse(JSON.stringify({ correct: 'parcial', score: 3, errors: [], praise: '', suggestion: '', response_es: '' })).correct).toBe('partial');
  });

  it('should clamp score to 0-5', () => {
    const over = parseGradeResponse(JSON.stringify({ correct: 'yes', score: 10, errors: [], praise: '', suggestion: '', response_es: '' }));
    expect(over.quality).toBe(5);

    const under = parseGradeResponse(JSON.stringify({ correct: 'no', score: -2, errors: [], praise: '', suggestion: '', response_es: '' }));
    expect(under.quality).toBe(0);
  });

  it('should handle missing fields gracefully', () => {
    const result = parseGradeResponse(JSON.stringify({ correct: 'no', score: 1 }));
    expect(result.errors).toEqual([]);
    expect(result.praise).toBe('');
    expect(result.suggestion).toBe('');
    expect(result.responseEs).toBe('');
  });

  it('should parse JSON wrapped in markdown code fences', () => {
    const text = '```json\n{"correct": "yes", "score": 4, "errors": [], "praise": "Bien!", "suggestion": "", "response_es": ""}\n```';
    const result = parseGradeResponse(text);
    expect(result.quality).toBe(4);
    expect(result.correct).toBe('yes');
  });

  it('should normalize error types', () => {
    const json = JSON.stringify({
      correct: 'partial',
      score: 3,
      errors: [
        { type: 'gramática', description: 'test', correction: 'fix' },
        { type: 'vocabulario', description: 'test', correction: 'fix' },
        { type: 'conjugación', description: 'test', correction: 'fix' },
        { type: 'pronunciación', description: 'test', correction: 'fix' },
      ],
      praise: '', suggestion: '', response_es: '',
    });

    const result = parseGradeResponse(json);
    expect(result.errors.map((e) => e.type)).toEqual([
      'grammar', 'vocab', 'conjugation', 'pronunciation',
    ]);
  });
});

describe('formatGradeFeedbackBlocks', () => {
  it('should format correct response', () => {
    const grade: GradeResult = {
      quality: 5,
      correct: 'yes',
      errors: [],
      praise: 'Perfecto!',
      suggestion: '',
      responseEs: 'Excelente trabajo.',
    };
    const blocks = formatGradeFeedbackBlocks(grade);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect((blocks[0] as any).text.text).toContain('Correcto');
  });

  it('should format partial response with errors', () => {
    const grade: GradeResult = {
      quality: 3,
      correct: 'partial',
      errors: [{ type: 'grammar', description: 'wrong tense', correction: 'use present' }],
      praise: 'Buen intento',
      suggestion: 'Practicá más',
      responseEs: 'Casi bien.',
    };
    const blocks = formatGradeFeedbackBlocks(grade);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(blocks);
    expect(text).toContain('Casi');
    expect(text).toContain('grammar');
    expect(text).toContain('Practicá');
  });

  it('should format incorrect response', () => {
    const grade: GradeResult = {
      quality: 1,
      correct: 'no',
      errors: [],
      praise: '',
      suggestion: 'Repasá',
      responseEs: '',
    };
    const blocks = formatGradeFeedbackBlocks(grade);
    expect((blocks[0] as any).text.text).toContain('Incorrecto');
  });
});
