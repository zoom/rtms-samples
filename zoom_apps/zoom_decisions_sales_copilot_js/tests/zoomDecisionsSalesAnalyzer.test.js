import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SALES_QUESTIONS,
  normalizeSalesDecisionResponse,
  recordSalesTurn,
  getSalesSessionHistory,
  updateHistorySpeakerRole,
  analyzeSalesTurn,
  buildSalesDecisionInput,
  resetAllSalesSessions
} from '../zoomDecisionsSalesAnalyzer.js';
import { SalesSessionStore } from '../salesSessionStore.js';
import { mintWsAuthToken, createAuthorizeRegistration } from '../wsAuth.js';

function makeDecisionPayload() {
  return {
    model: 'zoom-decisions',
    request_id: 'req-sales-1',
    answers: [
      {
        name: 'buyer_intent',
        type: 'choice',
        choice: 'pricing',
        confidence: 0.89,
        probabilities: [
          { value: 'pricing', probability: 0.89 },
          { value: 'objection', probability: 0.08 }
        ]
      },
      {
        name: 'objection',
        type: 'choice',
        choice: 'budget',
        confidence: 0.74,
        probabilities: [
          { value: 'budget', probability: 0.74 },
          { value: 'price', probability: 0.2 }
        ]
      },
      {
        name: 'deal_stage',
        type: 'choice',
        choice: 'negotiation',
        confidence: 0.82,
        probabilities: [{ value: 'negotiation', probability: 0.82 }]
      },
      {
        name: 'next_action',
        type: 'choice',
        choice: 'address_objection',
        confidence: 0.68,
        probabilities: [
          { value: 'address_objection', probability: 0.68 },
          { value: 'quantify_impact', probability: 0.21 },
          { value: 'share_proof', probability: 0.11 }
        ]
      },
      {
        name: 'purchase_signal',
        type: 'predicate',
        probability: 0.63
      },
      {
        name: 'deal_risk',
        type: 'score',
        score: 2.3,
        confidence: 0.77,
        probabilities: [{ value: '2', probability: 0.55 }]
      }
    ],
    usage: { prompt_tokens: 120, completion_tokens: 45 }
  };
}

test('uses all three Zoom Decisions primitives (choice, predicate, score)', () => {
  const types = new Set(Object.values(SALES_QUESTIONS).map((q) => q.type));
  assert.deepEqual(types, new Set(['choice', 'predicate', 'score']));
  assert.ok(Array.isArray(SALES_QUESTIONS.buyer_intent.choices));
  assert.ok(Array.isArray(SALES_QUESTIONS.deal_risk.levels));
});

test('normalizes a Zoom Decisions sales response into UI-safe analysis', () => {
  const normalized = normalizeSalesDecisionResponse(makeDecisionPayload());
  assert.equal(normalized.model, 'zoom-decisions');
  assert.equal(normalized.requestId, 'req-sales-1');
  assert.equal(normalized.buyerIntent.value, 'pricing');
  assert.equal(normalized.objection.value, 'budget');
  assert.equal(normalized.dealStage.value, 'negotiation');
  assert.equal(normalized.nextAction.value, 'address_objection');
  assert.equal(normalized.actionOptions.length, 3);
  assert.equal(normalized.actionOptions[0].recommended, true);
  assert.equal(normalized.purchaseSignal, 0.63);
  assert.equal(normalized.dealRisk.value, 2.3);
});

test('rejects missing answers array or refusal answers', () => {
  assert.throws(() => normalizeSalesDecisionResponse({}), /answers array/);
  assert.throws(
    () => normalizeSalesDecisionResponse({ answers: [{ name: 'buyer_intent', type: 'refusal' }] }),
    /refusal/
  );
});

test('records short turns and seller turns with [Buyer]/[Seller] tags and skips inference for Seller turns', async () => {
  resetAllSalesSessions();
  process.env.ZOOM_AI_SERVICES_API_KEY = 'test_' + 'a'.repeat(24);

  recordSalesTurn({ turnId: 't1', streamId: 's1', userId: 1, userName: 'Dana', role: 'seller', text: 'What is your Q3 budget?', timestamp: 1 });
  recordSalesTurn({ turnId: 't2', streamId: 's1', userId: 2, userName: 'Alex', role: 'buyer', text: '$50k', timestamp: 2 });

  const sellerResult = await analyzeSalesTurn({
    turnId: 't3',
    streamId: 's1',
    meetingId: 'm1',
    userId: 1,
    userName: 'Dana',
    role: 'seller',
    text: 'We can phase the rollout across two quarters.',
    timestamp: 3,
    fetchImpl: async () => { throw new Error('Should not call Zoom Decisions for seller turn'); }
  });
  assert.equal(sellerResult.skipped, true);
  assert.equal(sellerResult.reason, 'seller_turn');

  let capturedRequest = null;
  let capturedHeaders = null;
  const buyerResult = await analyzeSalesTurn({
    turnId: 't4',
    streamId: 's1',
    meetingId: 'm1',
    userId: 2,
    userName: 'Alex',
    role: 'buyer',
    text: 'That phased option sounds much more realistic for our team.',
    timestamp: 4,
    fetchImpl: async (_url, opts) => {
      capturedHeaders = opts.headers;
      capturedRequest = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(makeDecisionPayload()) };
    }
  });

  assert.equal(buyerResult.buyerIntent.value, 'pricing');
  assert.equal(capturedHeaders['x-api-key'], process.env.ZOOM_AI_SERVICES_API_KEY);
  assert.equal(capturedRequest.model, 'zoom-decisions');
  assert.equal(capturedRequest.reference_id, 't4');
  assert.equal(capturedRequest.questions.length, 6);
  assert.match(capturedRequest.input, /\[Seller\] Dana: What is your Q3 budget\?/);
  assert.match(capturedRequest.input, /\[Buyer\] Alex: \$50k/);

  updateHistorySpeakerRole('s1', { userId: 2, userName: 'Alex', role: 'seller' });
  const updatedHistory = getSalesSessionHistory('s1');
  assert.equal(updatedHistory.find((t) => t.id === 't2').speaker, '[Seller] Alex');

  const formatted = buildSalesDecisionInput(updatedHistory, updatedHistory[updatedHistory.length - 1], 'Enterprise SaaS');
  assert.match(formatted, /Enterprise SaaS/);
});

test('coalesces bursty buyer turns so at most one request is queued behind an in-flight call', async () => {
  resetAllSalesSessions();
  process.env.ZOOM_AI_SERVICES_API_KEY = 'test_' + 'a'.repeat(24);

  let releaseFirst;
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(makeDecisionPayload()) };
  };

  const p1 = analyzeSalesTurn({ turnId: 'b1', streamId: 's-burst', meetingId: 'm1', userId: 2, userName: 'Buyer', role: 'buyer', text: 'First buyer statement here', timestamp: 1, fetchImpl });
  const p2 = analyzeSalesTurn({ turnId: 'b2', streamId: 's-burst', meetingId: 'm1', userId: 2, userName: 'Buyer', role: 'buyer', text: 'Second buyer statement here', timestamp: 2, fetchImpl });
  const p3 = analyzeSalesTurn({ turnId: 'b3', streamId: 's-burst', meetingId: 'm1', userId: 2, userName: 'Buyer', role: 'buyer', text: 'Third buyer statement here', timestamp: 3, fetchImpl });

  releaseFirst();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(callCount, 2);
  assert.equal(r1.buyerIntent.value, 'pricing');
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'superseded');
  assert.equal(r3.buyerIntent.value, 'pricing');
  assert.equal(getSalesSessionHistory('s-burst').length, 3);
});

test('SalesSessionStore updates revised turns in place via TranscriptRevisionStore and replays snapshots', () => {
  const store = new SalesSessionStore();
  store.markRtmsStarted('m1', 'stream-1');
  store.registerViewerRole('m1', { userId: 10, userName: 'Rep', role: 'seller' });

  const first = store.applyTranscriptEvent({
    meetingId: 'm1',
    streamId: 'stream-1',
    userId: 20,
    userName: 'Prospect',
    sentenceId: 7,
    attribute: 1,
    text: 'We need price',
    timestamp: 100
  });
  const revision = store.applyTranscriptEvent({
    meetingId: 'm1',
    streamId: 'stream-1',
    userId: 20,
    userName: 'Prospect',
    sentenceId: 7,
    attribute: 2,
    isUpdate: true,
    text: 'We need pricing for 200 seats',
    timestamp: 110
  });

  assert.equal(revision.turnId, first.turnId);
  assert.equal(revision.transcript.revision, 1);
  assert.equal(revision.transcript.text, 'We need pricing for 200 seats');

  const snap = store.getSnapshot('m1');
  assert.equal(snap.rtmsActive, true);
  assert.equal(snap.turns.length, 1);
  assert.equal(snap.turns[0].transcript.id, first.turnId);
});

test('wsAuth authorizes active RTMS, static token, and verified HMAC token', async () => {
  const signingKey = 'test-' + 'a'.repeat(16);
  const token = mintWsAuthToken({ mid: 'm-sales', uid: 'u-1' }, signingKey);
  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'm-live' }],
    signingSecret: signingKey,
    env: { FRONTEND_WSS_AUTH_TOKEN: 'shared-key', ALLOW_PRE_RTMS_REGISTRATION: 'false' }
  });

  assert.equal((await authorize({ meetingUUID: 'm-live', userID: 'u-1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-sales', userID: 'u-1', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-wrong', userID: 'u-1', token })).authorized, false);
  assert.equal((await authorize({ meetingUUID: 'm-any', userID: 'u-1', token: 'shared-key' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-any', userID: 'u-1', token: 'bad' })).authorized, false);
});
