import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTranscriptArgs,
  evaluateConsentGate,
  MeetingTranscriptStore
} from '../transcriptPolicy.js';

test('normalizeTranscriptArgs properly parses (data, size, timestamp, metadata) without 1970 timestamp bug', () => {
  const realTs = 1764000000000;
  const buf = Buffer.from('Hello everyone', 'utf8');
  const parsed = normalizeTranscriptArgs(buf, buf.length, realTs, {
    userId: 42,
    userName: 'Alice',
    sentenceId: 7,
    attribute: 1
  });

  assert.equal(parsed.text, 'Hello everyone');
  assert.equal(parsed.size, buf.length);
  assert.equal(parsed.timestamp, realTs);
  assert.equal(new Date(parsed.timestamp).getUTCFullYear() >= 2025, true);
  assert.equal(parsed.userName, 'Alice');
  assert.equal(parsed.sentenceId, 7);
  assert.equal(parsed.isUpdate, false);
});

test('MeetingTranscriptStore handles attribute === 2 transcript rewinds in place', () => {
  const store = new MeetingTranscriptStore();
  const ts = 1764000000000;

  const first = store.apply(
    normalizeTranscriptArgs(Buffer.from('We should ship next teak'), 24, ts, {
      userId: 1,
      userName: 'Alice',
      sentenceId: 10,
      attribute: 1
    })
  );
  assert.equal(first.action, 'new');

  const revision = store.apply(
    normalizeTranscriptArgs(Buffer.from('We should ship next week'), 24, ts + 500, {
      userId: 1,
      userName: 'Alice',
      sentenceId: 10,
      attribute: 2
    })
  );
  assert.equal(revision.action, 'updated');
  assert.equal(store.sentences.size, 1);

  const lines = store.orderedLines();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('We should ship next week'));
  assert.ok(lines[0].includes('[revised]'));
});

test('evaluateConsentGate enforces unanimous drop and per-participant redaction server-side', () => {
  const pausedPolicy = {
    policyMode: 'unanimous',
    rtmsStatus: 'paused',
    unanimousConsent: false,
    consentedParticipants: []
  };
  assert.equal(evaluateConsentGate(pausedPolicy, { userName: 'Alice' }).action, 'drop');

  const unanimousOk = {
    policyMode: 'unanimous',
    rtmsStatus: 'running',
    unanimousConsent: true,
    consentedParticipants: [{ screenName: 'Alice' }]
  };
  assert.equal(evaluateConsentGate(unanimousOk, { userName: 'Alice' }).action, 'allow');

  const redactPolicy = {
    policyMode: 'redact',
    rtmsStatus: 'running',
    unanimousConsent: false,
    consentedParticipants: [{ participantUUID: 'u1', screenName: 'Alice' }]
  };
  assert.equal(evaluateConsentGate(redactPolicy, { userName: 'Alice' }).action, 'allow');
  assert.equal(evaluateConsentGate(redactPolicy, { userName: 'Bob' }).action, 'redact');
});
