import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTraitsFromText,
  MeetingTraitTracker,
  normalizeTraitExtraction,
  getOpenRouterConfig
} from '../chatWithOpenrouterForTraits.js';
import { createAuthorizeRegistration, mintWsAuthToken } from '../wsAuth.js';

test('extractTraitsFromText reads model lazily, caps max_tokens to 500, checks res.ok, and returns evidence phrases', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.OPENROUTER_MODEL = 'meta-llama/llama-4-scout:free';

  try {
    let capturedBody = null;
    const result = await extractTraitsFromText('How did the Q3 cohort perform? I appreciate how hard the team worked.', {
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            model: capturedBody.model,
            choices: [{
              message: {
                content: '```json\n{"Curiosity":["How did the Q3 cohort perform?"],"Empathy":["I appreciate how hard the team worked"],"Assertiveness":[],"Creativity":[],"Analytical":["Q3 cohort perform"]}\n```'
              }
            }]
          })
        };
      }
    });

    assert.equal(capturedBody.model, 'meta-llama/llama-4-scout:free');
    assert.equal(capturedBody.max_tokens, 500);
    assert.equal(result.counts.Curiosity, 1);
    assert.equal(result.counts.Empathy, 1);
    assert.equal(result.counts.Analytical, 1);
    assert.equal(result.evidence.length, 3);
    assert.equal(result.evidence[0].trait, 'Curiosity');

    await assert.rejects(
      () => extractTraitsFromText('test', {
        fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'bad gateway' })
      }),
      /OpenRouter HTTP 502/
    );
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = prevModel;
  }
});

test('getOpenRouterConfig defaults to meta-llama/llama-4-scout:free', () => {
  const prev1 = process.env.OPENROUTER_MODEL;
  const prev2 = process.env.DEFAULT_OPENROUTER_MODEL;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.DEFAULT_OPENROUTER_MODEL;
  try {
    assert.equal(getOpenRouterConfig().model, 'meta-llama/llama-4-scout:free');
  } finally {
    if (prev1 !== undefined) process.env.OPENROUTER_MODEL = prev1;
    if (prev2 !== undefined) process.env.DEFAULT_OPENROUTER_MODEL = prev2;
  }
});

test('MeetingTraitTracker isolates state per meeting and per speaker, and cleans up on stop', async () => {
  const tracker = new MeetingTraitTracker({
    extractor: async (text) => {
      if (text.includes('?')) {
        return normalizeTraitExtraction({ Curiosity: [text] });
      }
      return normalizeTraitExtraction({ Empathy: [text] });
    }
  });

  const a1 = tracker.ingestTranscript({
    meetingId: 'meeting-A',
    streamId: 'stream-A',
    userId: 'u1',
    userName: 'Alice',
    sentenceId: 1,
    text: 'Why did latency spike?'
  });
  const a2 = tracker.ingestTranscript({
    meetingId: 'meeting-A',
    streamId: 'stream-A',
    userId: 'u2',
    userName: 'Bob',
    sentenceId: 2,
    text: 'I completely understand your concern.'
  });
  const b1 = tracker.ingestTranscript({
    meetingId: 'meeting-B',
    streamId: 'stream-B',
    userId: 'u3',
    userName: 'Carol',
    sentenceId: 1,
    text: 'What if we test another region?'
  });

  await Promise.all([a1.analysisPromise, a2.analysisPromise, b1.analysisPromise]);

  const snapA = tracker.getSnapshot('meeting-A');
  const snapB = tracker.getSnapshot('meeting-B');

  assert.equal(snapA.aggregateTotals.Curiosity, 1);
  assert.equal(snapA.aggregateTotals.Empathy, 1);
  assert.equal(snapA.speakers.length, 2);
  assert.equal(snapA.speakers.find((s) => s.userId === 'u1').totals.Curiosity, 1);
  assert.equal(snapA.speakers.find((s) => s.userId === 'u2').totals.Empathy, 1);

  assert.equal(snapB.aggregateTotals.Curiosity, 1);
  assert.equal(snapB.aggregateTotals.Empathy, 0);

  tracker.clearMeeting('meeting-A', 'stream-A');
  assert.equal(tracker.getSnapshot('meeting-A').aggregateTotals.Curiosity, 0);
  assert.equal(tracker.getSnapshot('meeting-B').aggregateTotals.Curiosity, 1);
});

test('MeetingTraitTracker handles TranscriptRevisionStore rewinds without double-counting', async () => {
  const tracker = new MeetingTraitTracker({
    extractor: async (text) => {
      if (text.includes('data')) {
        return normalizeTraitExtraction({ Analytical: ['based on the data'], Curiosity: ['why did it drop?'] });
      }
      return normalizeTraitExtraction({ Curiosity: ['why did it'] });
    }
  });

  const initial = tracker.ingestTranscript({
    meetingId: 'meeting-rewind',
    streamId: 'stream-r',
    userId: 'u1',
    userName: 'Alice',
    sentenceId: 42,
    text: 'why did it'
  });
  await initial.analysisPromise;
  assert.equal(tracker.getSnapshot('meeting-rewind').aggregateTotals.Curiosity, 1);
  assert.equal(tracker.getSnapshot('meeting-rewind').aggregateTotals.Analytical, 0);

  // Revision arrives for same sentenceId
  const revised = tracker.ingestTranscript({
    meetingId: 'meeting-rewind',
    streamId: 'stream-r',
    userId: 'u1',
    userName: 'Alice',
    sentenceId: 42,
    isUpdate: true,
    attribute: 2,
    text: 'why did it drop based on the data?'
  });
  await revised.analysisPromise;

  const snap = tracker.getSnapshot('meeting-rewind');
  assert.equal(snap.aggregateTotals.Curiosity, 1); // NOT 2!
  assert.equal(snap.aggregateTotals.Analytical, 1);
  assert.equal(snap.utterances.length, 1);
  assert.equal(snap.evidenceFeed.length, 2);
});

test('wsAuth authorizes valid HMAC token and active RTMS connection', async () => {
  const signingKey = 'test-' + 'a'.repeat(12);
  const token = mintWsAuthToken({ mid: 'm-1', uid: 'u-1' }, signingKey);
  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'm-active' }],
    signingSecret: signingKey,
    env: { ALLOW_PRE_RTMS_REGISTRATION: 'false' }
  });

  assert.equal((await authorize({ meetingUUID: 'm-active', userID: 'u-1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-1', userID: 'u-1', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-other', userID: 'u-1', token })).authorized, false);
});
