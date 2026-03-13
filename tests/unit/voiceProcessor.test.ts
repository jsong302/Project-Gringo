import { describe, it, expect } from 'vitest';
import { formatVoiceResponseBlocks } from '../../src/services/voiceProcessor';
import type { VoiceResult } from '../../src/services/voiceProcessor';

describe('Voice Processor', () => {
  describe('formatVoiceResponseBlocks', () => {
    it('should format a normal charla response', () => {
      const result: VoiceResult = {
        transcript: {
          transcript: 'Hola, me llamo Carlos',
          confidence: 0.95,
          durationSec: 2.5,
          language: 'es',
        },
        response: {
          text: 'Hola Carlos! Bienvenido, che.',
          isExplanation: false,
          inputTokens: 50,
          outputTokens: 20,
        },
      };

      const blocks = formatVoiceResponseBlocks(result);
      expect(blocks.length).toBe(2);

      const transcript = (blocks[0] as any).elements[0].text;
      expect(transcript).toContain('Hola, me llamo Carlos');
      expect(transcript).toContain('95%');

      const response = (blocks[1] as any).text.text;
      expect(response).toContain('Hola Carlos');
    });

    it('should format an explanation response differently', () => {
      const result: VoiceResult = {
        transcript: {
          transcript: 'no entiendo',
          confidence: 0.88,
          durationSec: 1.0,
          language: 'es',
        },
        response: {
          text: 'Let me explain...',
          isExplanation: true,
          inputTokens: 50,
          outputTokens: 40,
        },
      };

      const blocks = formatVoiceResponseBlocks(result);
      const response = (blocks[1] as any).text.text;
      expect(response).toContain('Explicación');
    });
  });
});
