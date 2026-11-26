import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthorizeRegistration,
  encryptZoomAppContext,
  mintTokenFromZoomAppHeader
} from '../wsAuth.js';
import {
  INDUSTRY_TEMPLATES,
  extractJsonObject,
  extractStructuredNotes,
  listTemplates
} from '../nlp/industryExtractor.js';
import { NotetakerSessionManager } from '../notetakerSessionManager.js';

test('wsAuth: enforces fail-closed registration with RTMS, static token, and Zoom App context token', async () => {
  const clientSecret = 'note-client-secret';
  const signingSecret = 'note-signing-secret';
  const header = encryptZoomAppContext({ mid: 'clinic-101', uid: 'dr-chen' }, clientSecret);
  const token = mintTokenFromZoomAppHeader(header, { clientSecret, signingSecret });

  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'active-sync' }],
    authToken: 'note-static-token',
    signingSecret,
    allowPreRtms: false
  });

  assert.equal((await authorize({ meetingUUID: 'active-sync', userID: 'u1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'clinic-101', userID: 'dr-chen', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'other', userID: 'u1', token: 'note-static-token' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'other', userID: 'u1', token })).authorized, false);
  assert.equal((await authorize({ meetingUUID: 'other', userID: 'u1' })).authorized, false);
});

test('industryExtractor: supports all 6 industry templates, single structured JSON call, and graceful local fallback', async () => {
  const templateIds = listTemplates().map((t) => t.id);
  for (const expected of ['general', 'healthcare_soap', 'legal_compliance', 'sales_meddic', 'finance_advisory', 'engineering_rfc']) {
    assert.ok(templateIds.includes(expected), `Missing template ${expected}`);
    assert.ok(INDUSTRY_TEMPLATES[expected].sections.length >= 4);
  }

  // Extract JSON from fenced/chatty LLM output
  const parsed = extractJsonObject('Here is your result:\n```json\n{"summary":"Test","topics":["Clinical"]}\n```');
  assert.equal(parsed.summary, 'Test');

  // Single batched structured LLM call for healthcare_soap
  let fetchCount = 0;
  const llmResult = await extractStructuredNotes({
    templateId: 'healthcare_soap',
    apiKey: 'test-key',
    transcriptTurns: [
      { userName: 'Dr. Lee', text: 'Patient reports a persistent dry cough for five days.' },
      { userName: 'Dr. Lee', text: 'Blood pressure is 120 over 80 and lungs are clear.' }
    ],
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: 'Follow-up for 5-day dry cough; vitals stable.',
                sections: {
                  Subjective: ['Persistent dry cough for 5 days'],
                  Objective: ['BP 120/80, clear lungs'],
                  Assessment: ['Likely viral URI'],
                  Plan: ['Order chest X-ray if cough persists']
                },
                actionItems: [{ task: 'Schedule follow-up in 1 week', owner: 'Dr. Lee', dueDate: 'next week', priority: 'Medium' }],
                topics: ['Respiratory', 'Follow-up'],
                entities: [{ name: 'dry cough', type: 'Symptom' }]
              })
            }
          }]
        })
      };
    }
  });

  assert.equal(fetchCount, 1);
  assert.equal(llmResult.source, 'llm');
  assert.deepEqual(llmResult.sections.Subjective, ['Persistent dry cough for 5 days']);
  assert.equal(llmResult.actionItems[0].owner, 'Dr. Lee');

  // Graceful local fallback when OpenRouter returns HTTP 500
  const fallbackResult = await extractStructuredNotes({
    templateId: 'sales_meddic',
    apiKey: 'test-key',
    transcriptTurns: [
      { userName: 'Jordan', text: 'Acme Corp wants to cut onboarding cost by 30%. I\'ll send the pricing proposal by Friday.' }
    ],
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'Internal error' })
  });

  assert.equal(fallbackResult.source, 'fallback');
  assert.ok(fallbackResult.actionItems.length >= 1);
  assert.ok(fallbackResult.entities.some((e) => e.name === '30%'));
  assert.ok(fallbackResult.entities.some((e) => e.name === 'Acme Corp'));
});

test('NotetakerSessionManager: isolates meetings, handles transcript rewinds, preserves checked tasks, and wraps up on stop', async () => {
  const manager = new NotetakerSessionManager({
    batchSize: 5,
    batchDelayMs: 0,
    extractorFn: async ({ transcriptTurns, templateId, isFinalWrapup }) => ({
      summary: `${isFinalWrapup ? 'FINAL: ' : ''}${templateId} (${transcriptTurns.length} turns)`,
      sections: Object.fromEntries(INDUSTRY_TEMPLATES[templateId].sections.map((s) => [s, [`Item for ${s}`]])),
      actionItems: [{ task: 'Review architecture RFC', owner: 'Sam', dueDate: 'Friday', priority: 'High' }],
      topics: ['Architecture'],
      entities: [{ name: 'Sam', type: 'Owner' }],
      source: 'llm'
    })
  });

  // Meeting A selects engineering_rfc and ingests a sentence + rewind update
  manager.setTemplate('meeting-A', 'engineering_rfc');
  manager.ingestTranscript({
    meetingId: 'meeting-A',
    streamId: 'sA',
    userId: 'u1',
    userName: 'Sam',
    sentenceId: 10,
    text: 'We should migrate to event sourcing',
    timestamp: 1000
  });
  manager.ingestTranscript({
    meetingId: 'meeting-A',
    streamId: 'sA',
    userId: 'u1',
    userName: 'Sam',
    sentenceId: 10,
    isUpdate: true,
    attribute: 2,
    text: 'We should migrate to event sourcing by Q3',
    timestamp: 1050
  });

  // Starting Meeting B does NOT affect Meeting A
  manager.setTemplate('meeting-B', 'legal_compliance');
  manager.ingestTranscript({
    meetingId: 'meeting-B',
    streamId: 'sB',
    userId: 'u2',
    userName: 'Counsel',
    sentenceId: 1,
    text: 'Please review indemnity clause 4.2',
    timestamp: 2000
  });

  const stateA1 = await manager.analyzeNow('meeting-A');
  assert.equal(stateA1.transcript.length, 1); // rewind updated in place!
  assert.equal(stateA1.transcript[0].text, 'We should migrate to event sourcing by Q3');
  assert.equal(stateA1.templateId, 'engineering_rfc');
  assert.equal(stateA1.actionItems.length, 1);

  // Check off action item and confirm it stays completed after re-analysis
  const itemId = stateA1.actionItems[0].id;
  const toggled = manager.toggleActionItem('meeting-A', itemId);
  assert.equal(toggled.item.completed, true);

  const stateA2 = await manager.analyzeNow('meeting-A');
  assert.equal(stateA2.actionItems.find((i) => i.id === itemId).completed, true);

  // Markdown export includes template title, sections, and checked action item
  const md = manager.exportMarkdown('meeting-A');
  assert.match(md, /# Engineering RFC Notes/);
  assert.match(md, /- \[x\] Review architecture RFC/);

  // Finalize Meeting A on stop -> generates wrap-up and deletes Meeting A while leaving Meeting B intact
  const wrapup = await manager.finalizeAndCleanup('meeting-A');
  assert.match(wrapup.summary, /^FINAL: engineering_rfc/);
  assert.equal(manager.getSession('meeting-A'), null);
  assert.ok(manager.getSession('meeting-B'));
});
