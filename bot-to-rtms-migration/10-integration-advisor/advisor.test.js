import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, advise } from './src/advisor.js';
import { CAPABILITY_MATRIX } from './src/capabilities.js';

test('silent live capture recommends RTMS with the active-app indicator condition', () => {
  const r = advise({});
  assert.equal(r.recommendation, 'rtms');
  assert.ok(r.conditions.some((c) => c.includes('active-app indicator')));
  assert.ok(r.pieces.rtms.uses.length > 0);
  assert.equal(r.pieces.meetingSdk.uses.length, 0);
});

test('an in-meeting UI adds a Zoom App but stays RTMS', () => {
  const r = advise(SCENARIOS['compliance-monitor'].requirements);
  assert.equal(r.recommendation, 'rtms');
  assert.ok(r.pieces.zoomApps.uses.length > 0);
});

test('a speaking or visible bot stays on Meeting SDK, and becomes hybrid only when RTMS data is also wanted', () => {
  assert.equal(advise({ botSpeaks: true }).recommendation, 'meeting-sdk');
  assert.equal(advise({ visibleBot: true, sendsChat: true }).recommendation, 'meeting-sdk');
  assert.equal(advise({ hostControls: true }).recommendation, 'meeting-sdk');
  const hybrid = advise({ botSpeaks: true, wantsRtmsDataPlane: true });
  assert.equal(hybrid.recommendation, 'hybrid');
  assert.ok(hybrid.pieces.rtms.uses.length && hybrid.pieces.meetingSdk.uses.length);
});

test('authorization blockers beat everything, including a wish for hybrid', () => {
  for (const flag of [{ approvalAcceptable: false }, { externalCustomersCanAuthorize: false }, { adHocJoinByMeetingId: true }, { rawCaptureNotCovered: true }, { allParticipantVideoSimultaneously: true }]) {
    const r = advise({ ...flag, wantsRtmsDataPlane: true, botSpeaks: true });
    assert.equal(r.recommendation, 'meeting-sdk', JSON.stringify(flag));
    assert.ok(r.conditions.some((c) => c.includes('blockers')));
  }
});

test('no live action means recordings, not RTMS', () => {
  assert.equal(advise({ needsLiveAction: false }).recommendation, 'recording-api');
  assert.equal(advise({ crmArchiveOnly: true }).recommendation, 'recording-api');
  const r = advise({ needsLiveAction: false, botSpeaks: true });
  assert.equal(r.recommendation, 'recording-api');
  assert.ok(r.conditions.some((c) => c.includes('speech into the meeting')));
});

test('conditions: reconnect readiness, contact center entitlement, canonical recording', () => {
  assert.ok(advise({ canOperateReconnect: false }).conditions.some((c) => c.includes('50-start-and-approval and 60-stream-lifecycle-client')));
  assert.ok(advise({ contactCenter: true }).conditions.some((c) => c.includes('entitlement')));
  const r = advise({ canonicalRecording: true });
  assert.equal(r.recommendation, 'rtms');
  assert.ok(r.pieces.webhooksRest.uses.some((u) => u.includes('Recording')));
});

test('unknown requirement names are rejected instead of ignored', () => {
  assert.throws(() => advise({ botSpeakz: true }), /Unknown requirement/);
});

test('every built-in scenario produces a recommendation', () => {
  const expected = {
    'ai-assistant': 'rtms', 'revenue-call-analyzer': 'rtms', 'compliance-monitor': 'rtms', 'live-translation': 'rtms',
    'quality-management': 'recording-api', 'visible-assistant': 'meeting-sdk', 'voice-agent': 'meeting-sdk',
    'incident-scribe': 'rtms', 'support-wrap-up': 'rtms', 'media-archive': 'rtms', 'crm-archive': 'recording-api',
    'contact-center-assist': 'rtms', 'bot-with-compliance-feed': 'hybrid', 'ad-hoc-joiner': 'meeting-sdk'
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(SCENARIOS).sort());
  for (const [name, want] of Object.entries(expected)) assert.equal(advise(SCENARIOS[name].requirements).recommendation, want, name);
});

test('capability matrix says RTMS only receives', () => {
  const yes = CAPABILITY_MATRIX.filter((c) => c.rtms);
  assert.equal(yes.length, 1);
  assert.match(yes[0].capability, /Receive/);
});
