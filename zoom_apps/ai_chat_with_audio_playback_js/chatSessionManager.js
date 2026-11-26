import { randomUUID } from 'crypto';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';

export const VALID_MODES = new Set(['wake_word', 'push_to_talk', 'auto']);

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter((word) => word.length >= 2);
}

/**
 * Checks whether a spoken transcript starts with or contains a wake phrase.
 * Returns { matched, prompt } where `prompt` has the wake phrase stripped when followed by content.
 */
export function matchWakeWord(text, wakeWords = []) {
  const raw = String(text || '').trim();
  if (!raw || !Array.isArray(wakeWords) || wakeWords.length === 0) {
    return { matched: false, prompt: raw };
  }

  for (const phrase of wakeWords) {
    const cleanPhrase = String(phrase || '').trim();
    if (!cleanPhrase) continue;
    const escaped = cleanPhrase
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s,.-]+');
    const regex = new RegExp(`(?:^|\\b)${escaped}[\\s,.:;!?-]*`, 'i');
    const match = regex.exec(raw);
    if (match) {
      const after = raw.slice(match.index + match[0].length).trim();
      const before = raw.slice(0, match.index).trim();
      const prompt = after || before || raw;
      return { matched: true, prompt, wakeWord: cleanPhrase };
    }
  }

  return { matched: false, prompt: raw };
}

/**
 * Detects whether incoming speech is likely acoustic echo from recent TTS playback.
 */
export function isLikelyAcousticEcho(text, lastAiReplyText, lastAiReplyAt, {
  now = Date.now(),
  cooldownUntil = 0,
  echoWindowMs = 12000
} = {}) {
  const spokenNorm = normalizeText(text);
  const replyNorm = normalizeText(lastAiReplyText);
  if (!spokenNorm || !replyNorm) return false;

  if (now <= cooldownUntil) {
    return true;
  }

  if (now - lastAiReplyAt > echoWindowMs) {
    return false;
  }

  if (spokenNorm.length >= 10 && replyNorm.includes(spokenNorm)) {
    return true;
  }

  const spokenTokens = tokenize(spokenNorm);
  const replyTokenSet = new Set(tokenize(replyNorm));
  if (spokenTokens.length === 0 || replyTokenSet.size === 0) return false;

  let overlap = 0;
  for (const token of spokenTokens) {
    if (replyTokenSet.has(token)) overlap += 1;
  }

  const overlapRatio = overlap / spokenTokens.length;
  return spokenTokens.length >= 3 && overlapRatio >= 0.55;
}

export class ChatSessionManager {
  constructor(options = {}) {
    this.defaultMode = VALID_MODES.has(options.defaultMode) ? options.defaultMode : 'wake_word';
    this.defaultWakeWords = Array.isArray(options.defaultWakeWords) && options.defaultWakeWords.length > 0
      ? options.defaultWakeWords
      : ['hey ai', 'okay ai', 'ok ai', 'assistant'];
    this.maxHistoryMessages = Number(options.maxHistoryMessages) || 20;
    this.maxMessagesLog = Number(options.maxMessagesLog) || 60;
    this.echoCooldownMs = Number(options.echoCooldownMs) || 2500;
    this.echoWindowMs = Number(options.echoWindowMs) || 12000;
    this.sessions = new Map();
  }

  getOrCreateSession(meetingId) {
    const key = String(meetingId || 'default');
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        meetingId: key,
        transcriptStore: new TranscriptRevisionStore(),
        answeredSentenceKeys: new Set(),
        history: [],
        messagesLog: [],
        mode: this.defaultMode,
        wakeWords: [...this.defaultWakeWords],
        pttArmed: false,
        lastAiReplyText: '',
        lastAiReplyAt: 0,
        cooldownUntil: 0,
        epoch: 0,
        activeAbortController: null
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  getSession(meetingId) {
    return this.sessions.get(String(meetingId || 'default')) || null;
  }

  getPublicState(meetingId) {
    const session = this.getOrCreateSession(meetingId);
    return {
      meetingId: session.meetingId,
      mode: session.mode,
      wakeWords: [...session.wakeWords],
      pttArmed: session.pttArmed,
      messages: session.messagesLog.slice(-this.maxMessagesLog)
    };
  }

  updateSettings(meetingId, settings = {}) {
    const session = this.getOrCreateSession(meetingId);
    if (settings.mode && VALID_MODES.has(settings.mode)) {
      session.mode = settings.mode;
      if (settings.mode !== 'push_to_talk') {
        session.pttArmed = false;
      }
    }
    if (Array.isArray(settings.wakeWords)) {
      const cleaned = settings.wakeWords.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean);
      if (cleaned.length > 0) {
        session.wakeWords = cleaned.slice(0, 10);
      }
    } else if (typeof settings.wakeWords === 'string') {
      const cleaned = settings.wakeWords
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
      if (cleaned.length > 0) {
        session.wakeWords = cleaned.slice(0, 10);
      }
    }
    if (typeof settings.pttArmed === 'boolean') {
      session.pttArmed = settings.pttArmed;
    }
    return this.getPublicState(meetingId);
  }

  /**
   * Processes an RTMS transcript event with rewind handling, echo suppression, and mode gating.
   */
  handleTranscriptEvent(event, { now = Date.now() } = {}) {
    const meetingId = String(event.meetingId || event.rtmsId || 'default');
    const session = this.getOrCreateSession(meetingId);
    const revision = session.transcriptStore.apply(event);
    const text = String(revision.sentence.text || '').trim();
    const speaker = revision.sentence.userName || `User ${revision.sentence.userId ?? 'unknown'}`;

    const logItem = this.#upsertTranscriptMessage(session, {
      sentenceKey: revision.key,
      speaker,
      text,
      timestamp: Number(revision.sentence.timestamp) || now
    });

    if (!text) {
      return { session, revision, logItem, shouldReply: false, suppressedReason: 'empty' };
    }

    // Do not trigger duplicate LLM calls on transcript rewind updates for already-answered sentences
    if (revision.action === 'updated' && session.answeredSentenceKeys.has(revision.key)) {
      return { session, revision, logItem, shouldReply: false, suppressedReason: 'revision_already_answered' };
    }

    // Echo & cooldown suppression prevents speaker TTS output from looping back into the assistant
    if (isLikelyAcousticEcho(text, session.lastAiReplyText, session.lastAiReplyAt, {
      now,
      cooldownUntil: session.cooldownUntil,
      echoWindowMs: this.echoWindowMs
    })) {
      return { session, revision, logItem, shouldReply: false, suppressedReason: 'echo_suppressed' };
    }

    let promptText = text;
    if (session.mode === 'wake_word') {
      const wakeMatch = matchWakeWord(text, session.wakeWords);
      if (!wakeMatch.matched) {
        return { session, revision, logItem, shouldReply: false, suppressedReason: 'no_wake_word' };
      }
      promptText = wakeMatch.prompt;
    } else if (session.mode === 'push_to_talk') {
      if (!session.pttArmed) {
        return { session, revision, logItem, shouldReply: false, suppressedReason: 'ptt_not_armed' };
      }
      session.pttArmed = false;
    }

    session.answeredSentenceKeys.add(revision.key);
    this.#appendHistory(session, { role: 'user', content: `${speaker}: ${promptText}` });

    return {
      session,
      revision,
      logItem,
      shouldReply: true,
      promptText,
      speaker,
      suppressedReason: null
    };
  }

  /**
   * Records a directly typed chat prompt (always triggers a reply).
   */
  handleTypedMessage(meetingId, { text, speaker = 'Participant', now = Date.now() }) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;

    const session = this.getOrCreateSession(meetingId);
    const logItem = {
      id: randomUUID(),
      role: 'user',
      speaker,
      text: cleanText,
      source: 'typed',
      timestamp: now
    };
    this.#pushLog(session, logItem);
    this.#appendHistory(session, { role: 'user', content: `${speaker}: ${cleanText}` });

    return { session, logItem, promptText: cleanText, speaker };
  }

  beginReplyTurn(meetingId) {
    const session = this.getOrCreateSession(meetingId);
    if (session.activeAbortController) {
      session.activeAbortController.abort();
    }
    session.epoch += 1;
    const controller = new AbortController();
    session.activeAbortController = controller;
    return {
      epoch: session.epoch,
      signal: controller.signal,
      messages: [...session.history]
    };
  }

  isTurnCurrent(meetingId, epoch) {
    const session = this.getSession(meetingId);
    return Boolean(session && session.epoch === epoch);
  }

  recordAssistantReply(meetingId, text, { now = Date.now(), estimatedAudioMs = 0 } = {}) {
    const session = this.getOrCreateSession(meetingId);
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;

    this.#appendHistory(session, { role: 'assistant', content: cleanText });
    session.lastAiReplyText = cleanText;
    session.lastAiReplyAt = now;
    session.cooldownUntil = now + Math.max(this.echoCooldownMs, Math.min(estimatedAudioMs, 10000));

    const logItem = {
      id: randomUUID(),
      role: 'assistant',
      speaker: 'AI Assistant',
      text: cleanText,
      source: 'ai_response',
      timestamp: now
    };
    this.#pushLog(session, logItem);
    return logItem;
  }

  interrupt(meetingId) {
    const session = this.getSession(meetingId);
    if (!session) return { interrupted: false };
    session.epoch += 1;
    if (session.activeAbortController) {
      session.activeAbortController.abort();
      session.activeAbortController = null;
    }
    session.pttArmed = false;
    session.cooldownUntil = 0;
    return { interrupted: true, epoch: session.epoch };
  }

  clearSession(meetingId) {
    const key = String(meetingId || 'default');
    const session = this.sessions.get(key);
    if (!session) return false;
    if (session.activeAbortController) {
      session.activeAbortController.abort();
    }
    session.transcriptStore.clear();
    this.sessions.delete(key);
    return true;
  }

  #appendHistory(session, entry) {
    session.history.push(entry);
    if (session.history.length > this.maxHistoryMessages) {
      session.history.splice(0, session.history.length - this.maxHistoryMessages);
    }
  }

  #pushLog(session, item) {
    session.messagesLog.push(item);
    if (session.messagesLog.length > this.maxMessagesLog) {
      session.messagesLog.splice(0, session.messagesLog.length - this.maxMessagesLog);
    }
  }

  #upsertTranscriptMessage(session, { sentenceKey, speaker, text, timestamp }) {
    const existing = session.messagesLog.find((m) => m.sentenceKey && m.sentenceKey === sentenceKey);
    if (existing) {
      existing.text = text;
      existing.speaker = speaker;
      existing.timestamp = timestamp;
      return existing;
    }
    const item = {
      id: randomUUID(),
      sentenceKey,
      role: 'user',
      speaker,
      text,
      source: 'transcript',
      timestamp
    };
    this.#pushLog(session, item);
    return item;
  }
}
