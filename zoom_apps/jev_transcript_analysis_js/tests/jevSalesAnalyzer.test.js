import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeJevResponse,
  SALES_QUESTIONS,
  recordSalesTurn,
  analyzeSalesTurn,
  getSalesSessionHistory,
  updateHistorySpeakerRole,
  resetAllSalesSessions
} from '../jevSalesAnalyzer.js';
import { SalesSessionStore } from '../salesSessionStore.js';
import { createAuthorizeRegistration, mintWsAuthToken } from '../wsAuth.js';

function makeMockJevPayload(overrides = {}) {
  return {
    model: 'typesafe/jev-1.13',
    answers: {
      buyer_intent: { type: 'choice', choice: 'pricing', confidence: 0.91, probabilities: { pricing: 0.91 } },
      objection: { type: 'choice', choice: 'budget', confidence: 0.72 },
      deal_stage: { type: 'choice', choice: 'negotiation', confidence: 0.83 },
      next_action: {
        type: 'choice',
        choice: 'address_objection',
        confidence: 0.88,
        probabilities: {
          clarify_need: 0.07,
          address_objection: 0.88,
          pause_and_listen: 0.03,
          unknown_action: 0.02
        }
      },
      purchase_signal: { type: 'noul', noul: 0.67 },
      deal_risk: { type: 'score', score: 2.4, confidence: 0.76 }
    },
    usage: { input_tokens: 120, output_tokens: 0 },
    ...overrides
  };
}

test('uses all three Jev decision primitives', () => {
  const types = new Set(Object.values(SALES_QUESTIONS).map((question) => question.type));
  assert.deepEqual(types, new Set(['choice', 'noul', 'score']));
});

test('normalizes a Jev response into UI-safe sales analysis', () => {
  const result = normalizeJevResponse(makeMockJevPayload());

  assert.equal(result.buyerIntent.value, 'pricing');
  assert.equal(result.nextAction.value, 'address_objection');
  assert.equal(result.nextAction.label, 'Address the objection');
  assert.match(result.nextAction.suggestion, /concern/i);
  assert.deepEqual(result.actionOptions.map((option) => option.value), [
    'address_objection',
    'clarify_need',
    'pause_and_listen'
  ]);
  assert.equal(result.actionOptions[0].recommended, true);
  assert.equal(result.purchaseSignal, 0.67);
  assert.equal(result.dealRisk.value, 2.4);
});

test('rejects a response without typed answers', () => {
  assert.throws(() => normalizeJevResponse({}), /answers object/);
});

test('records short turns and seller turns with [Buyer]/[Seller] tags and skips Jev inference for Seller turns', async () => {
  resetAllSalesSessions();
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';

  try {
    // Short buyer turn recorded directly without calling Jev
    recordSalesTurn({
      turnId: 't-short',
      streamId: 'stream-ctx',
      userId: 'b1',
      userName: 'Jordan',
      role: 'buyer',
      text: '$50k'
    });

    // Seller turn should skip Jev inference but stay recorded in history
    let fetchCalls = 0;
    const sellerRes = await analyzeSalesTurn({
      turnId: 't-seller',
      streamId: 'stream-ctx',
      meetingId: 'm-1',
      userId: 's1',
      userName: 'Sam',
      role: 'seller',
      text: 'When are you targeting rollout for that budget?',
      fetchImpl: async () => {
        fetchCalls++;
        return { ok: true, status: 200, text: async () => JSON.stringify(makeMockJevPayload()) };
      }
    });
    assert.equal(sellerRes.skipped, true);
    assert.equal(sellerRes.reason, 'seller_turn');
    assert.equal(fetchCalls, 0);

    // Another short turn
    recordSalesTurn({
      turnId: 't-q3',
      streamId: 'stream-ctx',
      userId: 'b1',
      userName: 'Jordan',
      role: 'buyer',
      text: 'Q3.'
    });

    // Full buyer turn triggers Jev and sees ALL prior short + seller turns tagged with roles
    let capturedBody = null;
    await analyzeSalesTurn({
      turnId: 't-buyer-main',
      streamId: 'stream-ctx',
      meetingId: 'm-1',
      userId: 'b1',
      userName: 'Jordan',
      role: 'buyer',
      text: 'We need security review done before we can commit to the annual contract.',
      fetchImpl: async (_url, init) => {
        fetchCalls++;
        capturedBody = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify(makeMockJevPayload()) };
      }
    });

    assert.equal(fetchCalls, 1);
    const turns = capturedBody.state.recent_turns;
    assert.equal(turns.length, 4);
    assert.equal(turns[0].speaker, '[Buyer] Jordan');
    assert.equal(turns[0].text, '$50k');
    assert.equal(turns[1].speaker, '[Seller] Sam');
    assert.equal(turns[2].text, 'Q3.');
    assert.equal(turns[3].speaker, '[Buyer] Jordan');

    // Role update updates history tags
    updateHistorySpeakerRole('stream-ctx', { userId: 's1', role: 'buyer' });
    const updatedHistory = getSalesSessionHistory('stream-ctx');
    assert.equal(updatedHistory[1].speaker, '[Buyer] Sam');
  } finally {
    resetAllSalesSessions();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('coalesces bursty buyer turns so at most one request is queued behind an in-flight Jev call', async () => {
  resetAllSalesSessions();
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';

  try {
    let releaseFirst;
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise((r) => { releaseFirst = r; });
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(makeMockJevPayload()) };
    };

    const p1 = analyzeSalesTurn({
      turnId: 'burst-1', streamId: 'stream-burst', meetingId: 'm1',
      userId: 'b1', userName: 'Alex', role: 'buyer', text: 'First long question about pricing tiers.',
      fetchImpl: mockFetch
    });
    const p2 = analyzeSalesTurn({
      turnId: 'burst-2', streamId: 'stream-burst', meetingId: 'm1',
      userId: 'b1', userName: 'Alex', role: 'buyer', text: 'Second rapid question that gets superseded.',
      fetchImpl: mockFetch
    });
    const p3 = analyzeSalesTurn({
      turnId: 'burst-3', streamId: 'stream-burst', meetingId: 'm1',
      userId: 'b1', userName: 'Alex', role: 'buyer', text: 'Third latest question that should be analyzed.',
      fetchImpl: mockFetch
    });

    releaseFirst();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(callCount, 2); // Only first and third hit Jev; second was coalesced!
    assert.equal(r1.buyerIntent.value, 'pricing');
    assert.equal(r2.skipped, true);
    assert.equal(r2.reason, 'superseded');
    assert.equal(r3.buyerIntent.value, 'pricing');
    // All 3 turns remain in history
    assert.equal(getSalesSessionHistory('stream-burst').length, 3);
  } finally {
    resetAllSalesSessions();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('SalesSessionStore updates revised turns in place via TranscriptRevisionStore and replays snapshots', () => {
  const store = new SalesSessionStore();
  store.registerViewerRole('m-1', { userId: 'seller-1', userName: 'Sam', role: 'seller' });

  const first = store.applyTranscriptEvent({
    meetingId: 'm-1',
    streamId: 's-1',
    userId: 'buyer-1',
    userName: 'Taylor',
    sentenceId: 10,
    text: 'Can you share pricing for'
  });
  const revised = store.applyTranscriptEvent({
    meetingId: 'm-1',
    streamId: 's-1',
    userId: 'buyer-1',
    userName: 'Taylor',
    sentenceId: 10,
    isUpdate: true,
    attribute: 2,
    text: 'Can you share pricing for 200 seats?'
  });

  assert.equal(revised.turnId, first.turnId);
  assert.equal(revised.action, 'updated');
  assert.equal(revised.transcript.revision, 1);

  const snap = store.getSnapshot('m-1');
  assert.equal(snap.turns.length, 1);
  assert.equal(snap.turns[0].transcript.text, 'Can you share pricing for 200 seats?');
  assert.equal(snap.turns[0].transcript.role, 'buyer');

  store.markRtmsStopped('m-1', 's-1');
  assert.equal(store.getSnapshot('m-1').turns.length, 0);
});

test('wsAuth authorizes active RTMS, static token, and verified HMAC token', async () => {
  const secret = 'jev-secret-key';
  const token = mintWsAuthToken({ mid: 'meet-99', uid: 'u-1' }, secret);
  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'meet-live' }],
    signingSecret: secret,
    env: { FRONTEND_WSS_AUTH_TOKEN: 'dev-secret' }
  });

  assert.equal((await authorize({ meetingUUID: 'meet-live', userID: 'u-1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'meet-99', userID: 'u-1', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'meet-any', userID: 'u-1', token: 'dev-secret' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'meet-99', userID: 'u-1', token: 'wrong' })).authorized, false);
});
