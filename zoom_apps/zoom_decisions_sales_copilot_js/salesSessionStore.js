import { randomUUID } from 'crypto';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';

const MAX_STORED_TURNS = 100;

function normalizeIdentity(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Manages per-meeting sales conversation state:
 * - TranscriptRevisionStore rewind mapping (sentenceKey -> stable turnId)
 * - Buyer vs Seller role mapping per speaker
 * - Late-join replay snapshot (turns, analyses, roles, RTMS active state)
 */
export class SalesSessionStore {
  #meetings = new Map();
  #transcriptStore = new TranscriptRevisionStore();

  #getOrCreate(meetingId) {
    const key = String(meetingId || 'default');
    if (!this.#meetings.has(key)) {
      this.#meetings.set(key, {
        meetingId: key,
        streamIds: new Set(),
        rtmsActive: false,
        speakerRoles: new Map(), // 'id:...' or 'name:...' -> 'buyer' | 'seller'
        speakerDirectory: new Map(), // speakerKey -> { speakerKey, userId, userName, role }
        turnsByKey: new Map(), // sentenceKey -> entry
        turnOrder: [], // ordered sentenceKeys
        turnKeyById: new Map(), // turnId -> sentenceKey
        lastAnalyzedTextById: new Map()
      });
    }
    return this.#meetings.get(key);
  }

  markRtmsStarted(meetingId, streamId) {
    const meeting = this.#getOrCreate(meetingId);
    meeting.rtmsActive = true;
    if (streamId) meeting.streamIds.add(String(streamId));
  }

  markRtmsStopped(meetingId, streamId) {
    if (streamId) this.#transcriptStore.clear(streamId);
    const key = String(meetingId || '');
    const meeting = this.#meetings.get(key);
    if (meeting) {
      for (const sid of meeting.streamIds) {
        this.#transcriptStore.clear(sid);
      }
      this.#meetings.delete(key);
    }
  }

  clearAll() {
    this.#transcriptStore.clear();
    this.#meetings.clear();
  }

  getStreamIds(meetingId) {
    const meeting = this.#meetings.get(String(meetingId || ''));
    return meeting ? Array.from(meeting.streamIds) : [];
  }

  registerViewerRole(meetingId, { userId, userName, identityIds = [], role = 'seller' } = {}) {
    const normalizedRole = role === 'buyer' ? 'buyer' : 'seller';
    const meeting = this.#getOrCreate(meetingId);
    const ids = [userId, ...identityIds].map(normalizeIdentity).filter(Boolean);
    for (const id of ids) {
      meeting.speakerRoles.set(`id:${id}`, normalizedRole);
    }
    const nameKey = normalizeIdentity(userName);
    if (nameKey) {
      meeting.speakerRoles.set(`name:${nameKey}`, normalizedRole);
    }
    this.#recomputeRoles(meeting);
    return this.getSpeakers(meetingId);
  }

  setSpeakerRole(meetingId, { speakerKey, userId, userName, role }) {
    if (role !== 'buyer' && role !== 'seller') return this.getSpeakers(meetingId);
    const meeting = this.#getOrCreate(meetingId);
    if (speakerKey) meeting.speakerRoles.set(String(speakerKey), role);
    const idKey = normalizeIdentity(userId);
    if (idKey) meeting.speakerRoles.set(`id:${idKey}`, role);
    const nameKey = normalizeIdentity(userName);
    if (nameKey) meeting.speakerRoles.set(`name:${nameKey}`, role);
    this.#recomputeRoles(meeting);
    return this.getSpeakers(meetingId);
  }

  resolveRole(meetingId, { userId, userName }) {
    const meeting = this.#getOrCreate(meetingId);
    const idKey = normalizeIdentity(userId);
    const nameKey = normalizeIdentity(userName);

    if (idKey && meeting.speakerRoles.has(`id:${idKey}`)) {
      return meeting.speakerRoles.get(`id:${idKey}`);
    }
    if (nameKey && meeting.speakerRoles.has(`name:${nameKey}`)) {
      return meeting.speakerRoles.get(`name:${nameKey}`);
    }
    return 'buyer';
  }

  #recomputeRoles(meeting) {
    for (const speaker of meeting.speakerDirectory.values()) {
      speaker.role = this.resolveRole(meeting.meetingId, speaker);
    }
    for (const entry of meeting.turnsByKey.values()) {
      entry.transcript.role = this.resolveRole(meeting.meetingId, entry.transcript);
    }
  }

  applyTranscriptEvent(event) {
    const meetingId = String(event.meetingId || event.rtmsId || 'default');
    const meeting = this.#getOrCreate(meetingId);
    if (event.streamId) meeting.streamIds.add(String(event.streamId));
    meeting.rtmsActive = true;

    const applied = this.#transcriptStore.apply(event);
    const sentenceKey = applied.key;
    const text = String(applied.sentence.text || '').trim();
    const userId = applied.sentence.userId;
    const userName = applied.sentence.userName || `User ${userId ?? 'unknown'}`;
    const role = this.resolveRole(meetingId, { userId, userName });
    const speakerKey = normalizeIdentity(userId)
      ? `id:${normalizeIdentity(userId)}`
      : `name:${normalizeIdentity(userName)}`;

    meeting.speakerDirectory.set(speakerKey, {
      speakerKey,
      userId,
      userName,
      role
    });

    const existing = meeting.turnsByKey.get(sentenceKey);
    const turnId = existing?.transcript.id || randomUUID();
    const transcript = {
      id: turnId,
      sentenceKey,
      sentenceId: applied.sentence.sentenceId,
      revision: applied.sentence.revision,
      isUpdate: applied.action === 'updated' || applied.action === 'replaced',
      text,
      userId,
      userName,
      speakerKey,
      role,
      timestamp: Number(applied.sentence.timestamp) || existing?.transcript.timestamp || Date.now()
    };

    const entry = existing
      ? { ...existing, transcript }
      : { transcript, analysis: null, analysisPending: false };

    if (!existing) {
      meeting.turnOrder.push(sentenceKey);
      if (meeting.turnOrder.length > MAX_STORED_TURNS) {
        const evictedKey = meeting.turnOrder.shift();
        const evicted = meeting.turnsByKey.get(evictedKey);
        if (evicted) {
          meeting.turnKeyById.delete(evicted.transcript.id);
          meeting.lastAnalyzedTextById.delete(evicted.transcript.id);
        }
        meeting.turnsByKey.delete(evictedKey);
      }
    }

    meeting.turnsByKey.set(sentenceKey, entry);
    meeting.turnKeyById.set(turnId, sentenceKey);

    const lastAnalyzed = meeting.lastAnalyzedTextById.get(turnId);
    const textChangedSignificantly = !lastAnalyzed || normalizeIdentity(lastAnalyzed) !== normalizeIdentity(text);

    return {
      action: applied.action,
      turnId,
      transcript,
      textChangedSignificantly
    };
  }

  markPending(meetingId, turnId, pending) {
    const meeting = this.#meetings.get(String(meetingId || ''));
    const key = meeting?.turnKeyById.get(turnId);
    const entry = key ? meeting.turnsByKey.get(key) : null;
    if (entry) entry.analysisPending = Boolean(pending);
  }

  recordAnalysis(meetingId, turnId, analysis, analyzedText) {
    const meeting = this.#meetings.get(String(meetingId || ''));
    const key = meeting?.turnKeyById.get(turnId);
    const entry = key ? meeting.turnsByKey.get(key) : null;
    if (entry) {
      entry.analysis = analysis;
      entry.analysisPending = false;
    }
    if (meeting && analyzedText) {
      meeting.lastAnalyzedTextById.set(turnId, analyzedText);
    }
  }

  getSpeakers(meetingId) {
    const meeting = this.#meetings.get(String(meetingId || ''));
    if (!meeting) return [];
    return Array.from(meeting.speakerDirectory.values());
  }

  getSnapshot(meetingId) {
    const meeting = this.#meetings.get(String(meetingId || ''));
    if (!meeting) {
      return {
        meetingId: String(meetingId || ''),
        rtmsActive: false,
        speakers: [],
        turns: []
      };
    }

    return {
      meetingId: meeting.meetingId,
      rtmsActive: meeting.rtmsActive,
      speakers: this.getSpeakers(meetingId),
      turns: meeting.turnOrder
        .map((k) => meeting.turnsByKey.get(k))
        .filter(Boolean)
        .map((entry) => ({
          transcript: { ...entry.transcript },
          analysis: entry.analysis,
          analysisPending: entry.analysisPending
        }))
    };
  }
}
