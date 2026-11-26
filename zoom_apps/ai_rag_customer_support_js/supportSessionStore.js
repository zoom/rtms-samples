import { randomUUID } from 'crypto';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';

const MAX_TRANSCRIPTS_PER_MEETING = 120;
const MAX_SUGGESTIONS_PER_MEETING = 50;

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Manages per-meeting support sessions: transcript rewind state, speaker roles
 * (Agent vs Customer), rolling dialogue context, and suggestion history.
 */
export class SupportSessionStore {
  #meetings = new Map();
  #transcriptStore = new TranscriptRevisionStore();

  #getOrCreate(meetingId) {
    const key = String(meetingId || 'default');
    if (!this.#meetings.has(key)) {
      this.#meetings.set(key, {
        meetingId: key,
        streamIds: new Set(),
        rtmsActive: false,
        agentIdentities: new Set(),
        speakerRoles: new Map(), // normalized speaker key -> 'agent' | 'customer'
        speakerDirectory: new Map(), // speakerKey -> { speakerKey, userId, userName, role }
        turnsByKey: new Map(), // sentenceKey -> turn object
        turnOrder: [], // ordered sentenceKeys
        suggestions: [],
        lastAnalyzedTextByKey: new Map()
      });
    }
    return this.#meetings.get(key);
  }

  markRtmsStarted(meetingId, streamId) {
    const session = this.#getOrCreate(meetingId);
    session.rtmsActive = true;
    if (streamId) session.streamIds.add(String(streamId));
  }

  markRtmsStopped(meetingId, streamId) {
    if (streamId) {
      this.#transcriptStore.clear(streamId);
    }
    const key = String(meetingId || '');
    const session = this.#meetings.get(key);
    if (session) {
      for (const sid of session.streamIds) {
        this.#transcriptStore.clear(sid);
      }
      this.#meetings.delete(key);
    }
  }

  clearAll() {
    this.#transcriptStore.clear();
    this.#meetings.clear();
  }

  registerAgentIdentity(meetingId, { userId, userName, identityIds = [] } = {}) {
    const session = this.#getOrCreate(meetingId);
    const ids = [userId, ...identityIds].map(normalizeKey).filter(Boolean);
    for (const id of ids) {
      session.agentIdentities.add(id);
      session.speakerRoles.set(`id:${id}`, 'agent');
    }
    const nameKey = normalizeKey(userName);
    if (nameKey) {
      session.agentIdentities.add(nameKey);
      session.speakerRoles.set(`name:${nameKey}`, 'agent');
    }
    this.#recomputeRoles(session);
    return this.getSpeakers(meetingId);
  }

  setSpeakerRole(meetingId, { speakerKey, userId, userName, role }) {
    if (role !== 'agent' && role !== 'customer') return this.getSpeakers(meetingId);
    const session = this.#getOrCreate(meetingId);

    if (speakerKey) {
      session.speakerRoles.set(String(speakerKey), role);
    }
    const idKey = normalizeKey(userId);
    if (idKey) session.speakerRoles.set(`id:${idKey}`, role);
    const nameKey = normalizeKey(userName);
    if (nameKey) session.speakerRoles.set(`name:${nameKey}`, role);

    this.#recomputeRoles(session);
    return this.getSpeakers(meetingId);
  }

  resolveRole(meetingId, { userId, userName }) {
    const session = this.#getOrCreate(meetingId);
    const idKey = normalizeKey(userId);
    const nameKey = normalizeKey(userName);

    if (idKey && session.speakerRoles.has(`id:${idKey}`)) {
      return session.speakerRoles.get(`id:${idKey}`);
    }
    if (nameKey && session.speakerRoles.has(`name:${nameKey}`)) {
      return session.speakerRoles.get(`name:${nameKey}`);
    }
    if (idKey && session.agentIdentities.has(idKey)) return 'agent';
    if (nameKey && session.agentIdentities.has(nameKey)) return 'agent';
    return 'customer';
  }

  #recomputeRoles(session) {
    for (const speaker of session.speakerDirectory.values()) {
      speaker.role = this.resolveRole(session.meetingId, speaker);
    }
    for (const turn of session.turnsByKey.values()) {
      turn.role = this.resolveRole(session.meetingId, turn);
    }
  }

  applyTranscriptEvent(event) {
    const meetingId = String(event.meetingId || event.rtmsId || 'default');
    const session = this.#getOrCreate(meetingId);
    if (event.streamId) session.streamIds.add(String(event.streamId));
    session.rtmsActive = true;

    const applied = this.#transcriptStore.apply(event);
    const sentenceKey = applied.key;
    const text = String(applied.sentence.text || '').trim();
    const userId = applied.sentence.userId;
    const userName = applied.sentence.userName || `Participant ${userId ?? 'unknown'}`;
    const role = this.resolveRole(meetingId, { userId, userName });

    const speakerKey = normalizeKey(userId) ? `id:${normalizeKey(userId)}` : `name:${normalizeKey(userName)}`;
    session.speakerDirectory.set(speakerKey, {
      speakerKey,
      userId,
      userName,
      role
    });

    const existing = session.turnsByKey.get(sentenceKey);
    const turn = {
      id: existing?.id || randomUUID(),
      sentenceKey,
      sentenceId: applied.sentence.sentenceId,
      revision: applied.sentence.revision,
      isUpdate: applied.action === 'updated' || applied.action === 'replaced',
      userId,
      userName,
      speakerKey,
      role,
      text,
      timestamp: Number(applied.sentence.timestamp) || existing?.timestamp || Date.now()
    };

    if (!existing) {
      session.turnOrder.push(sentenceKey);
      if (session.turnOrder.length > MAX_TRANSCRIPTS_PER_MEETING) {
        const evictedKey = session.turnOrder.shift();
        session.turnsByKey.delete(evictedKey);
        session.lastAnalyzedTextByKey.delete(evictedKey);
      }
    }
    session.turnsByKey.set(sentenceKey, turn);

    const lastAnalyzed = session.lastAnalyzedTextByKey.get(sentenceKey);
    const textChangedSignificantly = !lastAnalyzed || normalizeKey(lastAnalyzed) !== normalizeKey(text);

    return {
      action: applied.action,
      turn,
      textChangedSignificantly,
      recentContext: this.getRecentContext(meetingId, 8)
    };
  }

  markSentenceAnalyzed(meetingId, sentenceKey, text) {
    const session = this.#getOrCreate(meetingId);
    session.lastAnalyzedTextByKey.set(sentenceKey, text);
  }

  addSuggestion(meetingId, suggestion) {
    const session = this.#getOrCreate(meetingId);
    const card = {
      id: suggestion.id || randomUUID(),
      createdAt: suggestion.createdAt || Date.now(),
      ...suggestion
    };
    // Update in place if same sentenceKey was revised
    if (card.sentenceKey) {
      const idx = session.suggestions.findIndex((s) => s.sentenceKey === card.sentenceKey);
      if (idx !== -1) {
        session.suggestions[idx] = { ...session.suggestions[idx], ...card, id: session.suggestions[idx].id };
        return session.suggestions[idx];
      }
    }
    session.suggestions.unshift(card);
    if (session.suggestions.length > MAX_SUGGESTIONS_PER_MEETING) {
      session.suggestions.length = MAX_SUGGESTIONS_PER_MEETING;
    }
    return card;
  }

  getRecentContext(meetingId, limit = 8) {
    const session = this.#meetings.get(String(meetingId || 'default'));
    if (!session) return [];
    return session.turnOrder
      .slice(-limit)
      .map((k) => session.turnsByKey.get(k))
      .filter(Boolean);
  }

  getSpeakers(meetingId) {
    const session = this.#meetings.get(String(meetingId || 'default'));
    if (!session) return [];
    return Array.from(session.speakerDirectory.values());
  }

  getSnapshot(meetingId) {
    const session = this.#meetings.get(String(meetingId || 'default'));
    if (!session) {
      return {
        meetingId: String(meetingId || ''),
        rtmsActive: false,
        turns: [],
        suggestions: [],
        speakers: []
      };
    }
    return {
      meetingId: session.meetingId,
      rtmsActive: session.rtmsActive,
      turns: session.turnOrder.map((k) => session.turnsByKey.get(k)).filter(Boolean),
      suggestions: session.suggestions.slice(),
      speakers: this.getSpeakers(meetingId)
    };
  }
}
