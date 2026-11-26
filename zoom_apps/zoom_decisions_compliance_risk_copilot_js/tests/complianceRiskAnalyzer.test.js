import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLIANCE_QUESTIONS,
  analyzeComplianceTurn,
  buildDecisionInput,
  getComplianceSessionSnapshot,
  isShortConsentUtterance,
  normalizeComplianceResponse,
  recordComplianceTurn,
  resetAllComplianceSessions,
  setSpeakerRole,
  shouldAnalyzeTranscript,
  updateChecklistFromAnalysis
} from '../complianceRiskAnalyzer.js';
import { createRegistrationAuthorizer, mintWsAuthToken } from '../wsAuth.js';

function makeMockDecisionResponse(overrides = {}) {
  return {
    model: 'zoom-decisions',
    request_id: overrides.requestId || 'req-1',
    answers: [
      { type: 'choice', name: 'conversation_stage', choice: overrides.stage || 'disclosure', probabilities: [] },
      { type: 'choice', name: 'compliance_state', choice: overrides.complianceState || 'compliant', probabilities: [{ value: overrides.complianceState || 'compliant', probability: 0.9 }] },
      { type: 'choice', name: 'missing_requirement', choice: overrides.missing || 'none', probabilities: [] },
      {
        type: 'choice',
        name: 'next_action',
        choice: overrides.nextAction || 'confirm_understanding',
        probabilities: [
          { value: overrides.nextAction || 'confirm_understanding', probability: 0.85 },
          { value: 'state_material_terms', probability: 0.1 }
        ]
      },
      { type: 'predicate', name: 'consent_recorded', probability: overrides.consent ?? 0.8 },
      { type: 'score', name: 'compliance_risk', score: overrides.risk ?? 1.0, probabilities: [] }
    ],
    usage: { input_units: 100, output_units: 0 }
  };
}

test('uses all three Zoom decision primitives', () => {
  const types = new Set(Object.values(COMPLIANCE_QUESTIONS).map((question) => question.type));
  assert.deepEqual(types, new Set(['choice', 'predicate', 'score']));
});

test('normalizes a compliance response', () => {
  const result = normalizeComplianceResponse({
    model: 'zoom-decisions',
    request_id: 'request-1',
    answers: [
      { type: 'choice', name: 'conversation_stage', choice: 'disclosure', probabilities: [] },
      { type: 'choice', name: 'compliance_state', choice: 'material_gap', probabilities: [{ value: 'material_gap', probability: 0.91 }] },
      { type: 'choice', name: 'missing_requirement', choice: 'fees', probabilities: [] },
      {
        type: 'choice',
        name: 'next_action',
        choice: 'state_material_terms',
        probabilities: [
          { value: 'confirm_understanding', probability: 0.07 },
          { value: 'state_material_terms', probability: 0.88 },
          { value: 'offer_alternatives', probability: 0.03 }
        ]
      },
      { type: 'predicate', name: 'consent_recorded', probability: 0.67 },
      { type: 'score', name: 'compliance_risk', score: 2.4, probabilities: [] }
    ],
    usage: { input_units: 120, output_units: 0 }
  });

  assert.equal(result.requestId, 'request-1');
  assert.equal(result.complianceState.value, 'material_gap');
  assert.equal(result.missingRequirement.value, 'fees');
  assert.equal(result.nextAction.value, 'state_material_terms');
  assert.equal(result.nextAction.label, 'State material terms');
  assert.deepEqual(result.actionOptions.map((option) => option.value), [
    'state_material_terms',
    'confirm_understanding',
    'offer_alternatives'
  ]);
  assert.equal(result.actionOptions[0].recommended, true);
  assert.equal(result.consentRecorded, 0.67);
  assert.equal(result.complianceRisk.value, 2.4);
});

test('rejects a response without typed answers', () => {
  assert.throws(() => normalizeComplianceResponse({}), /answers array/);
});

test('short consent utterances are recognized and always analyzed', () => {
  for (const phrase of ['Yes', 'No', 'I agree.', 'Correct', 'Okay', 'I consent!']) {
    assert.equal(isShortConsentUtterance(phrase), true, `Expected "${phrase}" to be recognized`);
    assert.equal(shouldAnalyzeTranscript(phrase, 12), true, `Expected "${phrase}" to be analyzed`);
  }
  assert.equal(shouldAnalyzeTranscript('hmm', 8), false);
});

test('recordComplianceTurn keeps short turns in history, handles rewinds in place, and formats [Agent]/[Customer] labels', () => {
  resetAllComplianceSessions();
  try {
    const first = recordComplianceTurn({
      turnId: 't-1',
      streamId: 'stream-1',
      meetingId: 'mtg-1',
      userId: 10,
      userName: 'Alice',
      speakerRole: 'agent',
      sentenceId: 1,
      text: 'The annual fee is twenty five dollars.'
    });
    assert.equal(first.action, 'new');
    assert.equal(first.turn.id, 't-1');

    // Rewind correction on same sentenceId updates in place with same stable turn ID
    const revised = recordComplianceTurn({
      turnId: 't-1-new',
      streamId: 'stream-1',
      meetingId: 'mtg-1',
      userId: 10,
      userName: 'Alice',
      sentenceId: 1,
      isUpdate: true,
      text: 'The annual fee is $25, waived in year one.'
    });
    assert.equal(revised.action, 'updated');
    assert.equal(revised.turn.id, 't-1');
    assert.equal(revised.turn.revision, 1);

    // Short customer consent turn is stored and flagged for analysis
    const consent = recordComplianceTurn({
      turnId: 't-2',
      streamId: 'stream-1',
      meetingId: 'mtg-1',
      userId: 20,
      userName: 'Bob',
      speakerRole: 'customer',
      sentenceId: 2,
      text: 'Yes'
    });
    assert.equal(consent.shouldAnalyze, true);

    const snapshot = getComplianceSessionSnapshot({ meetingId: 'mtg-1' });
    assert.equal(snapshot.turns.length, 2);
    assert.equal(snapshot.turns[0].text, 'The annual fee is $25, waived in year one.');
    assert.equal(snapshot.turns[1].text, 'Yes');

    // Switch role dynamically and verify prompt labels
    setSpeakerRole({ meetingId: 'mtg-1', userId: 20, userName: 'Bob', role: 'customer' });
    const fakeSession = {
      streamId: 'stream-1',
      revisionStore: {
        sentences: () => snapshot.turns
      },
      speakerRoles: new Map([['id:10', 'agent'], ['id:20', 'customer']])
    };
    const prompt = buildDecisionInput(fakeSession, snapshot.turns[1]);
    assert.match(prompt, /\[Agent\] Alice: The annual fee is \$25, waived in year one\./);
    assert.match(prompt, /\[Customer\] Bob: Yes/);
    assert.match(prompt, /Latest speaker: \[Customer\] Bob/);
  } finally {
    resetAllComplianceSessions();
  }
});

test('coalesces rapid Decisions API calls and updates persistent compliance checklist', async () => {
  resetAllComplianceSessions();
  const prevKey = process.env.ZOOM_AI_SERVICES_API_KEY;
  process.env.ZOOM_AI_SERVICES_API_KEY = 'test-key';

  let fetchCalls = 0;
  let capturedBodies = [];
  const resolvers = [];

  const mockFetch = async (_url, init) => {
    fetchCalls += 1;
    capturedBodies.push(JSON.parse(init.body));
    return await new Promise((resolve) => {
      resolvers.push(() => {
        const payload = fetchCalls === 1
          ? makeMockDecisionResponse({ stage: 'disclosure', complianceState: 'material_gap', missing: 'fees', consent: 0.2, risk: 3.0 })
          : makeMockDecisionResponse({ stage: 'closing', complianceState: 'compliant', missing: 'none', consent: 0.92, risk: 0.4 });
        resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload)
        });
      });
    });
  };

  try {
    const p1 = analyzeComplianceTurn({
      turnId: 't1',
      streamId: 'stream-coal',
      meetingId: 'mtg-coal',
      userId: 1,
      userName: 'Alice',
      speakerRole: 'agent',
      text: 'Welcome to regulated support.',
      fetchImpl: mockFetch
    });

    // Fire 3 rapid turns while p1 is still in flight -> must coalesce into a single 2nd fetch!
    const p2 = analyzeComplianceTurn({
      turnId: 't2',
      streamId: 'stream-coal',
      meetingId: 'mtg-coal',
      userId: 1,
      userName: 'Alice',
      speakerRole: 'agent',
      text: 'The fee is $10 per month and you can cancel anytime.',
      fetchImpl: mockFetch
    });
    const p3 = analyzeComplianceTurn({
      turnId: 't3',
      streamId: 'stream-coal',
      meetingId: 'mtg-coal',
      userId: 2,
      userName: 'Bob',
      speakerRole: 'customer',
      text: 'I agree',
      fetchImpl: mockFetch
    });

    assert.equal(fetchCalls, 1);
    resolvers.shift()();
    const r1 = await p1;
    assert.equal(r1.checklist.fees.status, 'missing');

    // Wait a tick for coalesced 2nd request to launch
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fetchCalls, 2);
    assert.match(capturedBodies[1].input, /\[Customer\] Bob: I agree/);

    resolvers.shift()();
    const [r2, r3] = await Promise.all([p2, p3]);
    assert.equal(r2.coalesced, true);
    assert.equal(r3.coalesced, true);
    assert.equal(r3.checklist.consent.status, 'completed');
    assert.equal(r3.checklist.fees.status, 'completed');
    assert.equal(r3.checklist.understanding.status, 'completed');
  } finally {
    if (prevKey === undefined) delete process.env.ZOOM_AI_SERVICES_API_KEY;
    else process.env.ZOOM_AI_SERVICES_API_KEY = prevKey;
    resetAllComplianceSessions();
  }
});

test('updateChecklistFromAnalysis marks customer confusion as missing understanding', () => {
  const checklist = {
    identity: { key: 'identity', label: 'Identity', status: 'pending' },
    consent: { key: 'consent', label: 'Consent', status: 'pending' },
    fees: { key: 'fees', label: 'Fees', status: 'pending' },
    risks: { key: 'risks', label: 'Risks', status: 'pending' },
    alternatives: { key: 'alternatives', label: 'Alternatives', status: 'pending' },
    understanding: { key: 'understanding', label: 'Understanding', status: 'pending' }
  };
  updateChecklistFromAnalysis(checklist, {
    conversationStage: { value: 'customer_questions' },
    complianceState: { value: 'customer_confusion' },
    missingRequirement: { value: 'risks' },
    consentRecorded: 0.1
  }, 't-9');
  assert.equal(checklist.risks.status, 'missing');
  assert.equal(checklist.understanding.status, 'missing');
});

test('wsAuth authorizeRegistration supports active RTMS, static token, and HMAC context token', async () => {
  const secret = 'copilot-secret';
  const token = mintWsAuthToken({ mid: 'mtg-42', uid: 'u-1' }, secret, 60_000);
  const auth = createRegistrationAuthorizer({
    getActiveConnections: () => [{ rtmsId: 'mtg-live' }],
    staticAuthToken: 'static-tok',
    signingSecret: secret,
    allowPreRtmsRegistration: false
  });

  assert.equal((await auth({ meetingUUID: 'mtg-live', userID: 'u' })).authorized, true);
  assert.equal((await auth({ meetingUUID: 'mtg-42', userID: 'u', token })).authorized, true);
  assert.equal((await auth({ meetingUUID: 'mtg-99', userID: 'u', token })).authorized, false);
  assert.equal((await auth({ meetingUUID: 'mtg-x', userID: 'u', token: 'static-tok' })).authorized, true);
  assert.equal((await auth({ meetingUUID: 'mtg-x', userID: 'u' })).authorized, false);
});
