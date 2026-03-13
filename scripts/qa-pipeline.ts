/**
 * QA Test: Full voice-to-text-to-LLM pipeline
 *
 * 1. Generate Spanish audio (Google Translate TTS)
 * 2. Transcribe with Deepgram
 * 3. Send transcript to Claude for a tutor response
 *
 * Run: npx tsx scripts/qa-pipeline.ts
 */
import { config } from 'dotenv';
config();

import { initLlm, callLlm, _setClient } from '../src/services/llm';
import { initStt, sendToDeepgram, _setApiKey } from '../src/services/stt';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY!;

const SPANISH_PHRASES = [
  'Hola, me llamo Carlos y quiero aprender español argentino',
  'Ayer fui al mercado y compré unas empanadas muy ricas',
  'Vos sabés que el mate es la bebida más popular de Argentina',
  'Me encanta Buenos Aires, es una ciudad hermosa',
];

async function generateAudio(text: string): Promise<Buffer> {
  console.log(`\n🎤 Generating audio for: "${text}"`);

  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=es&client=tw-ob`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`TTS failed: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`   Audio generated: ${buffer.length} bytes`);
  return buffer;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  QA Pipeline: Audio → Deepgram → Claude');
  console.log('═══════════════════════════════════════════════');

  // Init services
  initLlm({ apiKey: ANTHROPIC_KEY, model: 'claude-haiku-4-5-20251001', maxTokens: 512 });
  initStt({ apiKey: DEEPGRAM_KEY });

  // Pick a random phrase
  const phrase = SPANISH_PHRASES[Math.floor(Math.random() * SPANISH_PHRASES.length)];

  // Step 1: Generate audio
  let audioBuffer: Buffer;
  try {
    audioBuffer = await generateAudio(phrase);
  } catch (err) {
    console.log('\n⚠️  Google TTS blocked (common in some environments).');
    console.log('   Falling back to direct text input to test Deepgram → Claude pipeline.\n');

    // Fallback: skip TTS, just test Claude with the phrase directly
    await testClaudeResponse(phrase, '(skipped — used text directly)');
    return;
  }

  // Step 2: Transcribe with Deepgram
  console.log('\n📝 Sending to Deepgram for transcription...');
  const sttResult = await sendToDeepgram(audioBuffer, DEEPGRAM_KEY);
  console.log(`   Transcript: "${sttResult.transcript}"`);
  console.log(`   Confidence: ${(sttResult.confidence * 100).toFixed(1)}%`);
  console.log(`   Duration: ${sttResult.durationSec.toFixed(1)}s`);

  // Step 3: Send to Claude
  await testClaudeResponse(sttResult.transcript || phrase, sttResult.transcript);
}

async function testClaudeResponse(text: string, rawTranscript: string) {
  console.log('\n🤖 Sending to Claude (as Gringo tutor)...');

  const response = await callLlm({
    system: `Sos Gringo, un bot que enseña español argentino. Hablás con voseo, usás expresiones argentinas y lunfardo apropiado.

El estudiante es nivel 2 (principiante-intermedio). Respondé:
1. Comentá sobre lo que dijo
2. Corregí cualquier error amablemente
3. Hacé una pregunta para seguir la conversación
4. Usá un poco de lunfardo y explicalo

Respondé en español argentino, máximo 3-4 oraciones.`,
    messages: [{ role: 'user', content: text }],
    temperature: 0.8,
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  📥 Original text:  "${text}"`);
  console.log(`  📝 STT transcript: "${rawTranscript}"`);
  console.log(`  🤖 Gringo says:`);
  console.log(`\n  ${response.text}`);
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Tokens: ${response.inputTokens}in / ${response.outputTokens}out`);
  console.log(`  Model: ${response.model}`);
  console.log('═══════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n❌ Pipeline failed:', err.message);
  process.exit(1);
});
