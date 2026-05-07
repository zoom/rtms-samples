import fs from 'fs/promises';
import path from 'path';
import { KJUR } from 'jsrsasign';

function boolEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function validateRequired(value, name) {
  if (!value || String(value).trim() === '') {
    throw new Error(`${name} is required`);
  }
}

export function generateScribeJwt(apiKey, apiSecret) {
  validateRequired(apiKey, 'ZOOM_API_KEY');
  validateRequired(apiSecret, 'ZOOM_API_SECRET');

  const iat = Math.round(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60;

  return KJUR.jws.JWS.sign(
    'HS256',
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    JSON.stringify({ iss: apiKey, iat, exp }),
    apiSecret
  );
}

export function extractTranscriptText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;

  const candidates = [
    payload.text,
    payload.transcript,
    payload.result?.text,
    payload.result?.transcript,
    payload.result?.summary?.text
  ].filter(Boolean);

  if (candidates.length > 0) return String(candidates[0]);

  const segments = payload.result?.segments || payload.segments || payload.result?.utterances || payload.utterances;
  if (Array.isArray(segments)) {
    return segments
      .map((segment) => segment.text || segment.transcript || segment.words?.map((word) => word.text || word.word).join(' '))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  const words = payload.result?.words || payload.words;
  if (Array.isArray(words)) {
    return words.map((word) => word.text || word.word).filter(Boolean).join(' ').trim();
  }

  return '';
}

export class ScribeClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.apiSecret = options.apiSecret || '';
    this.baseUrl = String(options.baseUrl || 'https://api.zoom.us/v2').replace(/\/+$/, '');
    this.language = options.language || 'en-US';
    this.wordTimeOffsets = Boolean(options.wordTimeOffsets);
    this.timestamps = Boolean(options.timestamps);
    this.diarization = Boolean(options.diarization);
    this.channelSeparation = Boolean(options.channelSeparation);
    this.profanityFilter = Boolean(options.profanityFilter);
    this.outputFormat = options.outputFormat || 'json';
  }

  static fromEnv(env = process.env) {
    return new ScribeClient({
      apiKey: env.ZOOM_API_KEY,
      apiSecret: env.ZOOM_API_SECRET,
      baseUrl: env.SCRIBE_BASE_URL,
      language: env.SCRIBE_LANGUAGE || env.LANGUAGE || 'en-US',
      wordTimeOffsets: boolEnv(env.SCRIBE_WORD_TIME_OFFSETS, true),
      timestamps: boolEnv(env.SCRIBE_TIMESTAMPS, true),
      diarization: boolEnv(env.SCRIBE_DIARIZATION, false),
      channelSeparation: boolEnv(env.SCRIBE_CHANNEL_SEPARATION, false),
      profanityFilter: boolEnv(env.SCRIBE_PROFANITY_FILTER, false),
      outputFormat: env.SCRIBE_OUTPUT_FORMAT || 'json'
    });
  }

  get config() {
    return {
      language: this.language,
      word_time_offsets: this.wordTimeOffsets,
      timestamps: this.timestamps,
      diarization: this.diarization,
      channel_separation: this.channelSeparation,
      profanity_filter: this.profanityFilter,
      output_format: this.outputFormat
    };
  }

  async transcribeFile(filePath, metadata = {}) {
    const token = generateScribeJwt(this.apiKey, this.apiSecret);
    const fileBuffer = await fs.readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(fileBuffer)], { type: 'audio/wav' }), path.basename(filePath));
    form.append('config', JSON.stringify(this.config));

    const response = await fetch(`${this.baseUrl}/aiservices/scribe/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });

    const responseText = await response.text();
    let payload;
    try {
      payload = responseText ? JSON.parse(responseText) : {};
    } catch {
      payload = { raw: responseText };
    }

    if (!response.ok) {
      throw new Error(`Zoom Scribe transcription failed: ${response.status} ${responseText}`);
    }

    return {
      requestId: payload.request_id || payload.requestId || null,
      durationSec: payload.duration_sec ?? payload.durationSec ?? null,
      model: payload.model || null,
      text: extractTranscriptText(payload),
      rawResult: payload,
      metadata,
      timestamp: Date.now()
    };
  }
}

export default ScribeClient;
