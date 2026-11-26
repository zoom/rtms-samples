import { randomUUID } from 'crypto';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';
import {
  extractStructuredNotes,
  getTemplateById,
  listTemplates
} from './nlp/industryExtractor.js';

function emptySectionsFor(templateId) {
  const tpl = getTemplateById(templateId);
  const sections = {};
  for (const name of tpl.sections) {
    sections[name] = [];
  }
  return sections;
}

export class NotetakerSessionManager {
  constructor(options = {}) {
    this.defaultTemplateId = options.defaultTemplateId || 'general';
    this.batchSize = Number(options.batchSize) || 3;
    this.batchDelayMs = options.batchDelayMs ?? 4000;
    this.extractorFn = options.extractorFn || extractStructuredNotes;
    this.sessions = new Map();
  }

  getOrCreateSession(meetingId) {
    const key = String(meetingId || 'default');
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        meetingId: key,
        templateId: this.defaultTemplateId,
        transcriptStore: new TranscriptRevisionStore(),
        summary: '',
        sections: emptySectionsFor(this.defaultTemplateId),
        actionItems: [],
        topics: [],
        entities: [],
        extractionSource: 'idle',
        pendingNewTurns: 0,
        batchTimer: null,
        analyzing: false,
        lastAnalyzedAt: null,
        createdAt: Date.now()
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
    const template = getTemplateById(session.templateId);
    const transcript = session.transcriptStore.sentences().map((s) => ({
      sentenceKey: `${s.streamId}:${s.channelId ?? s.userId ?? null}:${s.sentenceId ?? `#${s.order}`}`,
      sentenceId: s.sentenceId,
      userId: s.userId,
      userName: s.userName || `User ${s.userId ?? 'unknown'}`,
      text: s.text,
      timestamp: Number(s.timestamp) || Date.now(),
      revision: s.revision
    }));

    return {
      meetingId: session.meetingId,
      templateId: template.id,
      templateName: template.name,
      templateSections: [...template.sections],
      templates: listTemplates(),
      summary: session.summary,
      sections: session.sections,
      actionItems: session.actionItems,
      topics: session.topics,
      entities: session.entities,
      extractionSource: session.extractionSource,
      lastAnalyzedAt: session.lastAnalyzedAt,
      transcript
    };
  }

  setTemplate(meetingId, templateId) {
    const session = this.getOrCreateSession(meetingId);
    const tpl = getTemplateById(templateId);
    session.templateId = tpl.id;
    session.sections = emptySectionsFor(tpl.id);
    return this.getPublicState(meetingId);
  }

  toggleActionItem(meetingId, itemId) {
    const session = this.getOrCreateSession(meetingId);
    const item = session.actionItems.find((a) => a.id === itemId);
    if (!item) return null;
    item.completed = !item.completed;
    return { item, state: this.getPublicState(meetingId) };
  }

  /**
   * Ingests an RTMS transcript event with TranscriptRevisionStore rewind deduplication
   * and triggers batched structured extraction.
   */
  ingestTranscript(event, { onNotesUpdate, now = Date.now() } = {}) {
    const meetingId = String(event.meetingId || event.rtmsId || 'default');
    const session = this.getOrCreateSession(meetingId);
    const revision = session.transcriptStore.apply(event);
    const text = String(revision.sentence.text || '').trim();
    const userName = revision.sentence.userName || `User ${revision.sentence.userId ?? 'unknown'}`;

    const turn = {
      sentenceKey: revision.key,
      action: revision.action,
      sentenceId: revision.sentence.sentenceId,
      userId: revision.sentence.userId,
      userName,
      text,
      timestamp: Number(revision.sentence.timestamp) || now,
      revision: revision.sentence.revision
    };

    if (!text) {
      return { turn, scheduled: false };
    }

    if (revision.action === 'new' || revision.action === 'recovered') {
      session.pendingNewTurns += 1;
    }

    if (typeof onNotesUpdate === 'function') {
      if (session.pendingNewTurns >= this.batchSize) {
        if (session.batchTimer) {
          clearTimeout(session.batchTimer);
          session.batchTimer = null;
        }
        void this.analyzeNow(meetingId).then((snapshot) => {
          if (snapshot) onNotesUpdate(snapshot);
        });
      } else if (this.batchDelayMs > 0) {
        if (session.batchTimer) clearTimeout(session.batchTimer);
        session.batchTimer = setTimeout(async () => {
          session.batchTimer = null;
          const snapshot = await this.analyzeNow(meetingId);
          if (snapshot) onNotesUpdate(snapshot);
        }, this.batchDelayMs);
      }
    }

    return { turn, scheduled: true };
  }

  async analyzeNow(meetingId, { isFinalWrapup = false } = {}) {
    const session = this.getSession(meetingId);
    if (!session) return null;
    if (session.analyzing && !isFinalWrapup) return null;

    const turns = session.transcriptStore.sentences().filter((s) => String(s.text || '').trim().length > 0);
    if (turns.length === 0) {
      return this.getPublicState(meetingId);
    }

    session.analyzing = true;
    session.pendingNewTurns = 0;

    try {
      const extracted = await this.extractorFn({
        transcriptTurns: turns,
        templateId: session.templateId,
        previousState: {
          summary: session.summary,
          sections: session.sections,
          actionItems: session.actionItems,
          topics: session.topics,
          entities: session.entities
        },
        isFinalWrapup
      });

      session.summary = extracted.summary || session.summary;
      session.sections = extracted.sections || session.sections;
      session.topics = Array.isArray(extracted.topics) ? extracted.topics : session.topics;
      session.entities = Array.isArray(extracted.entities) ? extracted.entities : session.entities;
      session.extractionSource = extracted.source || 'llm';
      session.lastAnalyzedAt = Date.now();

      // Merge action items while preserving completion status and IDs
      const existingByTask = new Map(
        session.actionItems.map((item) => [item.task.toLowerCase(), item])
      );
      const merged = [];
      for (const nextItem of extracted.actionItems || []) {
        const key = String(nextItem.task || '').trim().toLowerCase();
        if (!key) continue;
        const prev = existingByTask.get(key);
        if (prev) {
          merged.push({
            ...prev,
            owner: nextItem.owner || prev.owner,
            dueDate: nextItem.dueDate || prev.dueDate,
            priority: nextItem.priority || prev.priority
          });
          existingByTask.delete(key);
        } else {
          merged.push({
            id: randomUUID(),
            task: nextItem.task,
            owner: nextItem.owner || 'Unassigned',
            dueDate: nextItem.dueDate || '',
            priority: nextItem.priority || 'Medium',
            completed: false
          });
        }
      }
      // Keep any previously completed items so users don't lose checked tasks
      for (const remaining of existingByTask.values()) {
        if (remaining.completed) merged.push(remaining);
      }
      session.actionItems = merged;

      return this.getPublicState(meetingId);
    } finally {
      session.analyzing = false;
    }
  }

  /**
   * Generates a final wrap-up note snapshot and removes the meeting session from memory.
   */
  async finalizeAndCleanup(meetingId) {
    const key = String(meetingId || 'default');
    const session = this.sessions.get(key);
    if (!session) return null;

    if (session.batchTimer) {
      clearTimeout(session.batchTimer);
      session.batchTimer = null;
    }

    let finalState = null;
    if (session.transcriptStore.size > 0) {
      finalState = await this.analyzeNow(key, { isFinalWrapup: true });
    } else {
      finalState = this.getPublicState(key);
    }

    session.transcriptStore.clear();
    this.sessions.delete(key);
    return finalState;
  }

  exportMarkdown(meetingId) {
    const state = this.getPublicState(meetingId);
    const lines = [
      `# ${state.templateName} Notes`,
      `- **Meeting ID:** ${state.meetingId}`,
      `- **Generated:** ${new Date().toISOString()}`,
      '',
      '## Summary',
      state.summary || '_No summary yet._',
      ''
    ];

    for (const sectionName of state.templateSections) {
      lines.push(`## ${sectionName}`);
      const bullets = state.sections[sectionName] || [];
      if (bullets.length === 0) {
        lines.push('- _None captured._');
      } else {
        for (const bullet of bullets) {
          lines.push(`- ${bullet}`);
        }
      }
      lines.push('');
    }

    lines.push('## Action Items');
    if (state.actionItems.length === 0) {
      lines.push('- _No action items captured._');
    } else {
      for (const item of state.actionItems) {
        const mark = item.completed ? 'x' : ' ';
        const meta = [item.owner, item.priority, item.dueDate].filter(Boolean).join(' · ');
        lines.push(`- [${mark}] ${item.task}${meta ? ` _(${meta})_` : ''}`);
      }
    }
    lines.push('');

    lines.push('## Topics');
    lines.push(state.topics.length ? state.topics.join(', ') : '_None_');
    lines.push('');

    lines.push('## Extracted Entities');
    if (state.entities.length === 0) {
      lines.push('- _None_');
    } else {
      for (const ent of state.entities) {
        lines.push(`- **${ent.name}** (${ent.type})`);
      }
    }

    return lines.join('\n');
  }
}
