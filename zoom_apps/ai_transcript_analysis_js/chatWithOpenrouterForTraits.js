import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRAIT_NAMES = Object.freeze([
  'Curiosity',
  'Empathy',
  'Assertiveness',
  'Creativity',
  'Analytical'
]);

const DEFAULT_MODEL = 'meta-llama/llama-4-scout:free';
const DEFAULT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TOKENS = 500;
const MAX_TRANSCRIPTS_PER_MEETING = 120;
const MAX_EVIDENCE_ITEMS = 80;

let envLoaded = false;

function ensureEnvLoaded() {
  if (envLoaded) return;
  dotenv.config({ path: path.join(__dirname, '.env') });
  envLoaded = true;
}

export function createEmptyTraitCounts() {
  return {
    Curiosity: 0,
    Empathy: 0,
    Assertiveness: 0,
    Creativity: 0,
    Analytical: 0
  };
}

export function getOpenRouterConfig(overrides = {}) {
  ensureEnvLoaded();
  const apiKey = String(overrides.apiKey ?? process.env.OPENROUTER_API_KEY ?? '').trim();
  const model = String(
    overrides.model
      || process.env.OPENROUTER_MODEL
      || process.env.DEFAULT_OPENROUTER_MODEL
      || DEFAULT_MODEL
  ).trim();
  const endpoint = String(overrides.endpoint || process.env.OPENROUTER_API_URL || DEFAULT_API_URL).trim();
  const timeoutMs = Number(overrides.timeoutMs || process.env.OPENROUTER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return { apiKey, model, endpoint, timeoutMs };
}

function extractJsonObject(rawContent) {
  const text = String(rawContent || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function normalizeTraitExtraction(parsed = {}) {
  const counts = createEmptyTraitCounts();
  const phrases = {};
  const evidence = [];

  for (const trait of TRAIT_NAMES) {
    const rawList = Array.isArray(parsed?.[trait]) ? parsed[trait] : [];
    const seen = new Set();
    const cleaned = [];
    for (const item of rawList) {
      const phrase = String(item || '').trim().slice(0, 180);
      if (!phrase) continue;
      const lower = phrase.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      cleaned.push(phrase);
      if (cleaned.length >= 5) break;
    }
    phrases[trait] = cleaned;
    counts[trait] = cleaned.length;
    for (const phrase of cleaned) {
      evidence.push({ trait, phrase });
    }
  }

  return { counts, phrases, evidence };
}

/**
 * Stateless LLM trait extractor: extracts trait counts and matched evidence phrases
 * for a single transcript line. Reads env lazily and checks HTTP `res.ok`.
 */
export async function extractTraitsFromText(line, options = {}) {
  const text = String(line || '').trim();
  if (!text) {
    return normalizeTraitExtraction({});
  }

  const config = getOpenRouterConfig({ model: options.model });
  if (!config.apiKey || config.apiKey.startsWith('YOUR_')) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const prompt = [
    'Analyze the following meeting utterance and return ONLY a JSON object categorizing exact short phrases from the utterance that demonstrate these communication traits:',
    '- Curiosity (questions, exploration, probing for understanding)',
    '- Empathy (acknowledging feelings, validating others, supportive language)',
    '- Assertiveness (clear stance, decisive direction, confident ownership)',
    '- Creativity (novel ideas, reframing, brainstorming alternatives)',
    '- Analytical (data, metrics, trade-offs, structured reasoning)',
    '',
    'Return ONLY valid JSON with these exact keys (use empty arrays when none match):',
    '{',
    '  "Curiosity": [],',
    '  "Empathy": [],',
    '  "Assertiveness": [],',
    '  "Creativity": [],',
    '  "Analytical": []',
    '}',
    '',
    `Utterance:\n"${text.slice(0, 1200)}"`
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://github.com/zoom/rtms-samples',
        'X-Title': 'Zoom RTMS AI Transcript Analysis'
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${rawText.slice(0, 240)}`);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error('OpenRouter returned invalid JSON');
    }

    const content = payload?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);
    if (!parsed) {
      throw new Error('Model response did not contain a valid JSON object');
    }

    return {
      ...normalizeTraitExtraction(parsed),
      model: payload.model || config.model
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`OpenRouter request timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Isolated per-meeting & per-speaker trait tracker with:
 * - TranscriptRevisionStore rewind deduplication (no double-counting on updates)
 * - Per-meeting serialized + coalesced async update queue (no race conditions)
 * - Evidence phrase tracking per utterance and per speaker
 */
export class MeetingTraitTracker {
  #meetings = new Map();
  #transcriptStore = new TranscriptRevisionStore();
  #extractor;

  constructor({ extractor = extractTraitsFromText } = {}) {
    this.#extractor = extractor;
  }

  #getOrCreateMeeting(meetingId) {
    const key = String(meetingId || 'default');
    if (!this.#meetings.has(key)) {
      this.#meetings.set(key, {
        meetingId: key,
        streamIds: new Set(),
        rtmsActive: false,
        aggregateTotals: createEmptyTraitCounts(),
        speakers: new Map(), // speakerId -> { userId, userName, totals, utteranceCount }
        utterances: new Map(), // sentenceKey -> { id, sentenceKey, userId, userName, text, timestamp, revision, counts, evidence }
        utteranceOrder: [],
        evidenceFeed: [],
        pendingByKey: new Map(), // sentenceKey -> latest queued task
        processing: false
      });
    }
    return this.#meetings.get(key);
  }

  #getOrCreateSpeaker(meeting, userId, userName) {
    const speakerId = String(userId ?? userName ?? 'unknown');
    if (!meeting.speakers.has(speakerId)) {
      meeting.speakers.set(speakerId, {
        userId: speakerId,
        userName: userName || `Participant ${speakerId}`,
        totals: createEmptyTraitCounts(),
        utteranceCount: 0
      });
    } else if (userName) {
      meeting.speakers.get(speakerId).userName = userName;
    }
    return meeting.speakers.get(speakerId);
  }

  markRtmsStarted(meetingId, streamId) {
    const meeting = this.#getOrCreateMeeting(meetingId);
    meeting.rtmsActive = true;
    if (streamId) meeting.streamIds.add(String(streamId));
  }

  clearMeeting(meetingId, streamId) {
    if (streamId) this.#transcriptStore.clear(streamId);
    const key = String(meetingId || '');
    const meeting = this.#meetings.get(key);
    if (meeting) {
      for (const sid of meeting.streamIds) {
        this.#transcriptStore.clear(sid);
      }
      meeting.pendingByKey.clear();
      this.#meetings.delete(key);
    }
  }

  clearAll() {
    this.#transcriptStore.clear();
    this.#meetings.clear();
  }

  /**
   * Records a transcript event via TranscriptRevisionStore and enqueues a serialized,
   * coalesced LLM trait update for that meeting.
   */
  ingestTranscript(event, onAnalyzed) {
    const meetingId = String(event.meetingId || event.rtmsId || 'default');
    const meeting = this.#getOrCreateMeeting(meetingId);
    if (event.streamId) meeting.streamIds.add(String(event.streamId));
    meeting.rtmsActive = true;

    const applied = this.#transcriptStore.apply(event);
    const sentenceKey = applied.key;
    const text = String(applied.sentence.text || '').trim();
    const speakerId = String(applied.sentence.userId ?? applied.sentence.userName ?? 'unknown');
    const userName = applied.sentence.userName || `Participant ${speakerId}`;
    const speaker = this.#getOrCreateSpeaker(meeting, speakerId, userName);

    const existing = meeting.utterances.get(sentenceKey);
    const isNew = !existing;
    const utterance = existing
      ? {
          ...existing,
          userName,
          text,
          revision: applied.sentence.revision,
          isUpdate: applied.action === 'updated' || applied.action === 'replaced'
        }
      : {
          id: randomUUID(),
          sentenceKey,
          sentenceId: applied.sentence.sentenceId,
          userId: speakerId,
          userName,
          text,
          timestamp: Number(applied.sentence.timestamp) || Date.now(),
          revision: applied.sentence.revision,
          isUpdate: false,
          counts: createEmptyTraitCounts(),
          evidence: [],
          analyzedText: null
        };

    if (isNew) {
      speaker.utteranceCount += 1;
      meeting.utteranceOrder.push(sentenceKey);
      if (meeting.utteranceOrder.length > MAX_TRANSCRIPTS_PER_MEETING) {
        const evictedKey = meeting.utteranceOrder.shift();
        meeting.utterances.delete(evictedKey);
      }
    }
    meeting.utterances.set(sentenceKey, utterance);

    // Enqueue / coalesce analysis task for this sentenceKey
    const promise = new Promise((resolve) => {
      const prior = meeting.pendingByKey.get(sentenceKey);
      if (prior) {
        prior.resolve({ skipped: true, reason: 'coalesced' });
      }
      meeting.pendingByKey.set(sentenceKey, {
        sentenceKey,
        text,
        onAnalyzed,
        resolve
      });
    });

    this.#drainMeetingQueue(meeting);

    return {
      utterance: { ...utterance },
      action: applied.action,
      analysisPromise: promise
    };
  }

  async #drainMeetingQueue(meeting) {
    if (meeting.processing) return;
    meeting.processing = true;

    try {
      while (meeting.pendingByKey.size > 0) {
        const firstEntry = meeting.pendingByKey.entries().next().value;
        if (!firstEntry) break;
        const [sentenceKey, task] = firstEntry;
        meeting.pendingByKey.delete(sentenceKey);

        // Meeting may have been cleared while awaiting a previous call
        if (!this.#meetings.has(meeting.meetingId)) {
          task.resolve({ skipped: true, reason: 'meeting_stopped' });
          continue;
        }

        const utterance = meeting.utterances.get(sentenceKey);
        if (!utterance || !task.text) {
          task.resolve({ skipped: true, reason: 'empty' });
          continue;
        }

        if (utterance.analyzedText && utterance.analyzedText.toLowerCase() === task.text.toLowerCase()) {
          task.resolve({ skipped: true, reason: 'unchanged' });
          continue;
        }

        try {
          const extracted = await this.#extractor(task.text);

          // Re-check meeting still active after async LLM call
          if (!this.#meetings.has(meeting.meetingId)) {
            task.resolve({ skipped: true, reason: 'meeting_stopped' });
            continue;
          }

          const currentUtterance = meeting.utterances.get(sentenceKey) || utterance;
          const speaker = this.#getOrCreateSpeaker(meeting, currentUtterance.userId, currentUtterance.userName);

          // Rewind-safe accounting: subtract previous counts for this sentence before adding new counts
          const prevCounts = currentUtterance.counts || createEmptyTraitCounts();
          for (const trait of TRAIT_NAMES) {
            const delta = (extracted.counts[trait] || 0) - (prevCounts[trait] || 0);
            meeting.aggregateTotals[trait] = Math.max(0, (meeting.aggregateTotals[trait] || 0) + delta);
            speaker.totals[trait] = Math.max(0, (speaker.totals[trait] || 0) + delta);
          }

          currentUtterance.counts = { ...extracted.counts };
          currentUtterance.evidence = extracted.evidence.slice();
          currentUtterance.analyzedText = task.text;

          // Replace previous evidence feed entries for this sentenceKey
          meeting.evidenceFeed = meeting.evidenceFeed.filter((item) => item.sentenceKey !== sentenceKey);
          for (const item of extracted.evidence) {
            meeting.evidenceFeed.unshift({
              id: randomUUID(),
              sentenceKey,
              userId: currentUtterance.userId,
              userName: currentUtterance.userName,
              trait: item.trait,
              phrase: item.phrase,
              text: currentUtterance.text,
              timestamp: currentUtterance.timestamp
            });
          }
          if (meeting.evidenceFeed.length > MAX_EVIDENCE_ITEMS) {
            meeting.evidenceFeed.length = MAX_EVIDENCE_ITEMS;
          }

          const updatePayload = {
            meetingId: meeting.meetingId,
            utterance: { ...currentUtterance },
            currentCounts: extracted.counts,
            evidence: extracted.evidence,
            aggregateTotals: { ...meeting.aggregateTotals },
            speakers: this.#serializeSpeakers(meeting),
            evidenceFeed: meeting.evidenceFeed.slice(0, 40)
          };

          if (typeof task.onAnalyzed === 'function') {
            task.onAnalyzed(updatePayload);
          }
          task.resolve(updatePayload);
        } catch (err) {
          console.error(`[Traits] Extraction failed for meeting ${meeting.meetingId}:`, err.message);
          task.resolve({ error: err.message });
        }
      }
    } finally {
      meeting.processing = false;
      if (meeting.pendingByKey.size > 0 && this.#meetings.has(meeting.meetingId)) {
        this.#drainMeetingQueue(meeting);
      }
    }
  }

  #serializeSpeakers(meeting) {
    return Array.from(meeting.speakers.values()).map((s) => ({
      userId: s.userId,
      userName: s.userName,
      utteranceCount: s.utteranceCount,
      totals: { ...s.totals }
    }));
  }

  getSnapshot(meetingId) {
    const meeting = this.#meetings.get(String(meetingId || ''));
    if (!meeting) {
      return {
        meetingId: String(meetingId || ''),
        rtmsActive: false,
        aggregateTotals: createEmptyTraitCounts(),
        speakers: [],
        utterances: [],
        evidenceFeed: []
      };
    }

    return {
      meetingId: meeting.meetingId,
      rtmsActive: meeting.rtmsActive,
      aggregateTotals: { ...meeting.aggregateTotals },
      speakers: this.#serializeSpeakers(meeting),
      utterances: meeting.utteranceOrder.map((k) => meeting.utterances.get(k)).filter(Boolean),
      evidenceFeed: meeting.evidenceFeed.slice(0, 40)
    };
  }
}
