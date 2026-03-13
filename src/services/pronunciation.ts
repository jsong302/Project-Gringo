/**
 * Pronunciation audio generation.
 *
 * The LLM calls the `pronounce` tool when it wants to generate
 * pronunciation audio. This module handles the TTS generation.
 */
import { synthesizeSpeech, synthesizeBilingualSpeech, isTtsAvailable } from './tts';
import { log } from '../utils/logger';

const pronLog = log.withScope('pronunciation');

/**
 * Generate TTS audio for a list of phrases.
 * Returns an array of Buffers (or null for failed phrases).
 */
export async function generatePronunciationAudio(
  phrases: string[],
): Promise<(Buffer | null)[]> {
  if (!isTtsAvailable()) {
    pronLog.warn('TTS not available — skipping pronunciation audio');
    return phrases.map(() => null);
  }

  pronLog.info(`Generating audio for ${phrases.length} phrase(s): ${phrases.join(', ')}`);

  const results: (Buffer | null)[] = [];
  for (const phrase of phrases) {
    try {
      const audio = await synthesizeSpeech(phrase);
      results.push(audio);
    } catch (err) {
      pronLog.error(`TTS failed for "${phrase}": ${err}`);
      results.push(null);
    }
  }

  return results;
}

/**
 * Generate a bilingual correction audio clip.
 * English explanation + Spanish correct answer in a single voice clip.
 */
export async function generateCorrectionAudio(
  feedback: string,
  correction: string,
): Promise<Buffer | null> {
  if (!isTtsAvailable()) {
    pronLog.warn('TTS not available — skipping correction audio');
    return null;
  }

  // Keep the English part short — just the key feedback
  const shortFeedback = feedback.length > 200 ? feedback.slice(0, 200) + '...' : feedback;

  try {
    const audio = await synthesizeBilingualSpeech([
      { text: shortFeedback, lang: 'en' },
      { text: `The correct way to say it is:`, lang: 'en' },
      { text: correction, lang: 'es' },
    ]);
    pronLog.info(`Correction audio generated for: "${correction.slice(0, 50)}"`);
    return audio;
  } catch (err) {
    pronLog.error(`Correction audio failed: ${err}`);
    return null;
  }
}
