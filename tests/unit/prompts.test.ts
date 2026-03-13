import { describe, it, expect } from 'vitest';
import { interpolate } from '../../src/services/prompts';

describe('interpolate', () => {
  it('should replace a single placeholder', () => {
    expect(interpolate('Hello {{name}}!', { name: 'Maria' })).toBe(
      'Hello Maria!',
    );
  });

  it('should replace multiple placeholders', () => {
    const result = interpolate('Level {{level}}, name {{name}}', {
      level: '3',
      name: 'Carlos',
    });
    expect(result).toBe('Level 3, name Carlos');
  });

  it('should replace repeated placeholders', () => {
    const result = interpolate('{{x}} and {{x}}', { x: 'yes' });
    expect(result).toBe('yes and yes');
  });

  it('should leave unknown placeholders as-is', () => {
    const result = interpolate('{{known}} and {{unknown}}', { known: 'ok' });
    expect(result).toBe('ok and {{unknown}}');
  });

  it('should handle empty vars', () => {
    expect(interpolate('No {{vars}} here', {})).toBe('No {{vars}} here');
  });

  it('should handle template with no placeholders', () => {
    expect(interpolate('No placeholders', { key: 'val' })).toBe(
      'No placeholders',
    );
  });

  it('should handle empty template', () => {
    expect(interpolate('', { key: 'val' })).toBe('');
  });

  it('should only match word characters in placeholder names', () => {
    // {{with-dash}} should not be matched (dash is not \w)
    expect(interpolate('{{with-dash}}', { 'with-dash': 'x' })).toBe(
      '{{with-dash}}',
    );
  });
});
