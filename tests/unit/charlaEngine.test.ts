import { describe, it, expect } from 'vitest';
import { detectNoEntiendo } from '../../src/services/charlaEngine';

describe('Charla Engine', () => {
  describe('detectNoEntiendo', () => {
    // Should detect
    it('should detect "no entiendo"', () => {
      expect(detectNoEntiendo('No entiendo')).toBe(true);
    });

    it('should detect "no entiendo" case insensitive', () => {
      expect(detectNoEntiendo('NO ENTIENDO')).toBe(true);
    });

    it('should detect "no comprendo"', () => {
      expect(detectNoEntiendo('no comprendo nada')).toBe(true);
    });

    it('should detect "what?" in English', () => {
      expect(detectNoEntiendo('what?')).toBe(true);
    });

    it('should detect "I don\'t understand"', () => {
      expect(detectNoEntiendo("I don't understand")).toBe(true);
    });

    it('should detect "help"', () => {
      expect(detectNoEntiendo('help')).toBe(true);
    });

    it('should detect "explain"', () => {
      expect(detectNoEntiendo('can you explain that?')).toBe(true);
    });

    it('should detect "qué significa"', () => {
      expect(detectNoEntiendo('¿Qué significa eso?')).toBe(true);
    });

    it('should detect "???"', () => {
      expect(detectNoEntiendo('???')).toBe(true);
    });

    it('should detect "what does that mean"', () => {
      expect(detectNoEntiendo('What does that mean')).toBe(true);
    });

    // Should NOT detect
    it('should not detect normal Spanish', () => {
      expect(detectNoEntiendo('Hola, ¿cómo andás?')).toBe(false);
    });

    it('should not detect normal English in Spanish context', () => {
      expect(detectNoEntiendo('Me gusta el mate')).toBe(false);
    });

    it('should not detect "entiendo" (I understand)', () => {
      expect(detectNoEntiendo('Sí, entiendo perfectamente')).toBe(false);
    });
  });
});
