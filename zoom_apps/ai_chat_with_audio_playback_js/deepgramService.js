import { createClient } from '@deepgram/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

let cachedClient = null;
let cachedKey = null;

function getDeepgramClient(apiKey = process.env.DEEPGRAM_API_KEY) {
  if (!apiKey) {
    throw new Error('DEEPGRAM_API_KEY is not configured');
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = createClient(apiKey);
    cachedKey = apiKey;
  }
  return cachedClient;
}

/**
 * Convert text to speech using Deepgram's TTS API.
 * Defaults to linear16 WAV at 24kHz so browser clients can decode reliably with decodeAudioData().
 * @param {string} text
 * @param {Object} [options]
 * @returns {Promise<Buffer>}
 */
export async function textToSpeech(text, options = {}) {
  const {
    model = process.env.DEEPGRAM_TTS_MODEL || 'aura-asteria-en',
    encoding = 'linear16',
    sample_rate = 24000,
    container = 'wav',
    apiKey = process.env.DEEPGRAM_API_KEY,
    client
  } = options;

  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Cannot synthesize empty text');
  }

  const dg = client || getDeepgramClient(apiKey);
  const response = await dg.speak.request(
    { text: trimmed },
    {
      model,
      encoding,
      sample_rate,
      container
    }
  );

  const stream = await response.getStream();
  if (!stream) {
    throw new Error('No audio stream received from Deepgram');
  }

  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/**
 * Convert text to speech and return base64 encoded WAV audio.
 * @param {string} text
 * @param {Object} [options]
 * @returns {Promise<string>}
 */
export async function textToSpeechBase64(text, options = {}) {
  const audioBuffer = await textToSpeech(text, options);
  return audioBuffer.toString('base64');
}
