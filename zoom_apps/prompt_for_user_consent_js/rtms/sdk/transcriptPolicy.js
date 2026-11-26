/**
 * Server-side consent gating and transcript rewind helper for the RTMS SDK service.
 *
 * Handles:
 * - Correct `@zoom/rtms` onTranscriptData(data, size, timestamp, metadata) parsing
 * - Transcript rewinds (`attribute === 2`) by replacing sentences in place
 * - Server-side policy enforcement (`unanimous` drop vs `redact` per-participant redaction)
 */

export function normalizeTranscriptArgs(data, size, timestamp, metadata) {
  const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data ?? '');

  // Standard `@zoom/rtms` callback signature: (data, size, timestamp, metadata)
  // Guard against timestamp in seconds vs milliseconds or missing timestamp.
  let parsedTs = Number(timestamp);
  if (!Number.isFinite(parsedTs) || parsedTs <= 0) {
    parsedTs = Date.now();
  } else if (parsedTs < 1e12) {
    // Convert seconds to milliseconds if needed
    parsedTs = parsedTs * 1000;
  }

  const meta = (metadata && typeof metadata === 'object') ? metadata : {};
  const userId = meta.userId ?? meta.user_id ?? null;
  const userName = meta.userName ?? meta.user_name ?? 'Unknown';
  const participantUUID = meta.participantUUID ?? meta.participant_uuid ?? null;
  const sentenceId = meta.sentenceId ?? meta.sentence_id ?? null;
  const attribute = meta.attribute ?? null;
  const isUpdate = meta.isUpdate === true || Number(attribute) === 2;

  return {
    text,
    size: Number.isFinite(Number(size)) ? Number(size) : Buffer.byteLength(text, 'utf8'),
    timestamp: parsedTs,
    userId,
    userName,
    participantUUID,
    sentenceId,
    attribute,
    isUpdate
  };
}

export function isPolicyRunning(policy) {
  return policy?.rtmsStatus === 'running' || policy?.rtmsStatus === 'active';
}

/**
 * Evaluate server-side consent gating for a single transcript utterance.
 * Returns { action: 'allow' | 'redact' | 'drop', reason: string }.
 */
export function evaluateConsentGate(policy, speaker = {}) {
  if (!policy) {
    return { action: 'drop', reason: 'no_consent_policy' };
  }

  if (!isPolicyRunning(policy)) {
    return { action: 'drop', reason: `rtms_${policy.rtmsStatus || 'stopped'}` };
  }

  const mode = policy.policyMode === 'redact' ? 'redact' : 'unanimous';

  if (mode === 'unanimous') {
    if (!policy.unanimousConsent) {
      return { action: 'drop', reason: 'unanimous_consent_required' };
    }
    return { action: 'allow', reason: 'unanimous_consent_granted' };
  }

  // Per-participant redaction mode
  const consented = Array.isArray(policy.consentedParticipants)
    ? policy.consentedParticipants
    : [];

  const speakerUuid = speaker.participantUUID ? String(speaker.participantUUID) : null;
  const speakerId = speaker.userId !== null && speaker.userId !== undefined ? String(speaker.userId) : null;
  const speakerName = speaker.userName ? String(speaker.userName).trim().toLowerCase() : null;

  const isConsented = consented.some((p) => {
    if (speakerUuid && p.participantUUID && String(p.participantUUID) === speakerUuid) return true;
    if (speakerId && (String(p.participantID || '') === speakerId || String(p.participantUUID || '') === speakerId)) return true;
    if (speakerName && p.screenName && p.screenName.trim().toLowerCase() === speakerName) return true;
    return false;
  });

  if (isConsented) {
    return { action: 'allow', reason: 'participant_consented' };
  }

  return { action: 'redact', reason: 'participant_not_consented' };
}

/**
 * Keeps the latest text of each transcript sentence (handles attribute === 2 rewinds).
 */
export class MeetingTranscriptStore {
  constructor() {
    this.sentences = new Map();
    this.order = 0;
  }

  apply(entry) {
    const speakerKey = entry.userId ?? entry.userName ?? 'unknown';
    const sentenceId = entry.sentenceId ?? null;
    const isUpdate = entry.isUpdate === true || Number(entry.attribute) === 2;

    if (sentenceId === null) {
      const key = `${speakerKey}:#${this.order}`;
      const record = {
        ...entry,
        key,
        order: this.order++,
        revision: 0
      };
      this.sentences.set(key, record);
      return { action: 'new', record };
    }

    const key = `${speakerKey}:${sentenceId}`;
    const existing = this.sentences.get(key);
    const record = {
      ...entry,
      key,
      order: existing ? existing.order : this.order++,
      revision: existing ? existing.revision + 1 : 0,
      timestamp: existing ? existing.timestamp : entry.timestamp
    };
    this.sentences.set(key, record);

    if (isUpdate) {
      return { action: existing ? 'updated' : 'recovered', record };
    }
    return { action: existing ? 'replaced' : 'new', record };
  }

  orderedLines() {
    return Array.from(this.sentences.values())
      .sort((a, b) => a.order - b.order)
      .map((entry) => {
        const timeStr = new Date(entry.timestamp).toISOString();
        const revTag = entry.revision > 0 ? ' [revised]' : '';
        return `[${timeStr}] ${entry.userName}${revTag}: ${entry.text}`;
      });
  }
}
