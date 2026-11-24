import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPE, MSG } from '../shared/codes.js';
import { createMemoryTrace } from '../shared/trace.js';
import { DEFAULT_MEDIA_PARAMS } from '../60-stream-lifecycle-client/src/streamClient.js';
import { createParticipantRegistry } from './src/participants.js';
import { createVideoSubscriptionManager } from './src/videoSubscription.js';
import { buildMediaParams, fromSdkRaw } from './src/mediaProfile.js';

const J = EVENT_TYPE.PARTICIPANT_JOIN;
const L = EVENT_TYPE.PARTICIPANT_LEAVE;
const VON = EVENT_TYPE.PARTICIPANT_VIDEO_ON;
const VOFF = EVENT_TYPE.PARTICIPANT_VIDEO_OFF;
const SPK = EVENT_TYPE.ACTIVE_SPEAKER_CHANGE;
const registry = () => createParticipantRegistry({ tenantId: 'acme', meetingId: 'm1', streamId: 's1' });
const people = (...p) => p.map(([user_id, user_name]) => ({ user_id, user_name }));

test('registry: join, duplicate join, rename and rejoin are keyed by user ID', () => {
  const r = registry();
  const changes = [];
  r.subscribe((c) => changes.push(c.type));
  r.handleEvent({ event_type: J, timestamp: 100, participants: people([1, 'Ana'], [2, 'Ben']) });
  r.handleEvent({ event_type: J, timestamp: 150, participants: people([1, 'Ana']) });
  assert.equal(r.get(1).presence.length, 1, 'duplicate join is not a second person');
  r.handleEvent({ event_type: J, timestamp: 200, participants: people([1, 'Ana Lopez']) });
  assert.deepEqual(r.get(1).names.map((n) => n.name), ['Ana', 'Ana Lopez']);
  r.handleEvent({ event_type: L, timestamp: 300, user_id: 2, user_name: 'Ben' });
  r.handleEvent({ event_type: J, timestamp: 400, participants: people([2, 'Ben']) });
  assert.deepEqual(r.get(2).presence, [{ from: 100, to: 300 }, { from: 400, to: null }]);
  assert.deepEqual(changes, ['join', 'join', 'rename', 'leave', 'join']);
});

test('registry: two people with the same name stay separate and get distinct labels', () => {
  const r = registry();
  r.handleEvent({ event_type: J, timestamp: 1, participants: people([10, 'Sam'], [11, 'Sam'], [12, 'Kim']) });
  assert.equal(r.label(10), 'Sam (id 10)');
  assert.equal(r.label(11), 'Sam (id 11)');
  assert.equal(r.label(12), 'Kim');
  r.handleEvent({ event_type: L, timestamp: 2, user_id: 11 });
  assert.equal(r.label(10), 'Sam', 'unique again once the other Sam left');
  assert.equal(r.label(999), 'user 999');
});

test('registry: leaving ends video and speaking, and video ends before the leave notification', () => {
  const r = registry();
  const changes = [];
  r.handleEvent({ event_type: J, timestamp: 1, participants: people([1, 'Ana']) });
  r.handleEvent({ event_type: VON, timestamp: 2, participants: people([1, 'Ana']) });
  r.handleEvent({ event_type: SPK, timestamp: 3, user_id: 1, user_name: 'Ana' });
  r.subscribe((c) => changes.push(`${c.type}:${c.cause || ''}`));
  r.handleEvent({ event_type: L, timestamp: 10, user_id: 1 });
  assert.deepEqual(changes, ['video_off:left', 'leave:']);
  const p = r.get(1);
  assert.deepEqual([p.video[0].to, p.speaking[0].to, p.presence[0].to], [10, 10, 10]);
  assert.equal(r.attributeVideo(1, 11), false, 'no frames for someone who left');
  assert.equal(r.attributeVideo(1, 5), true, 'history is preserved');
  assert.equal(r.attributeAudio(11).userId, null);
});

test('registry: mixed audio is attributed from speaker intervals and silence is never guessed', () => {
  const r = registry();
  r.handleEvent({ event_type: J, timestamp: 0, participants: people([1, 'Ana'], [2, 'Ben']) });
  r.handleEvent({ event_type: SPK, timestamp: 100, user_id: 1, user_name: 'Ana' });
  r.handleEvent({ event_type: SPK, timestamp: 200, user_id: 2, user_name: 'Ben' });
  r.handleEvent({ event_type: SPK, timestamp: 300, user_id: 0 });
  assert.deepEqual([50, 100, 199, 200, 299, 300, 400].map((t) => r.attributeAudio(t).userId), [null, 1, 1, 2, 2, null, null]);
  assert.equal(r.attributeAudio(50).basis, 'no_active_speaker');
  assert.equal(r.attributeAudio(150).basis, 'active_speaker_interval');
  assert.equal(r.get(1).speaking[0].closedBy, 'speaker_changed');
});

test('registry: video interval lifecycle, implicit participants and role changes', () => {
  const r = registry();
  r.handleEvent({ event_type: VON, timestamp: 5, participants: people([7, 'Zed']) });
  assert.equal(r.get(7).implicit, true, 'seen on video before any join event');
  assert.deepEqual(r.videoOnUsers(), [7]);
  r.handleEvent({ event_type: VON, timestamp: 6, participants: people([7, 'Zed']) });
  assert.equal(r.get(7).video.length, 1, 'repeated video-on does not open a second interval');
  r.handleEvent({ event_type: VOFF, timestamp: 9, participants: people([7]) });
  assert.equal(r.isVideoOn(7), false);
  assert.equal(r.setRole(7, 'cohost', 9), true);
  assert.equal(r.setRole(7, 'cohost', 10), false);
  r.handleEvent({ event_type: J, timestamp: 11, participants: people([7, 'Zed']) });
  assert.equal(r.get(7).implicit, false, 'a real join clears the implicit flag');

  // Implicit active speaker (seen speaking before any join event) must still close cleanly on leave.
  r.handleEvent({ event_type: SPK, timestamp: 20, user_id: 8, user_name: 'May' });
  assert.equal(r.get(8).present, true);
  r.handleEvent({ event_type: L, timestamp: 30, user_id: 8 });
  assert.deepEqual([r.get(8).present, r.get(8).speaking[0].to, r.attributeAudio(35).userId], [false, 30, null]);
});

test('registry: ignores events without a stream timestamp or unrelated types, links Zoom App IDs, finalizes intervals', () => {
  const r = registry();
  assert.equal(r.handleEvent({ event_type: J, participants: people([1, 'Ana']) }).handled, false);
  assert.equal(r.handleEvent({ event_type: EVENT_TYPE.MEDIA_CONNECTION_INTERRUPTED, timestamp: 1 }).handled, false);
  r.handleEvent({ event_type: J, timestamp: 1, participants: people([1, 'Ana']) });
  r.handleEvent({ event_type: VON, timestamp: 2, participants: people([1, 'Ana']) });
  r.linkZoomAppParticipant('uuid-ana', 1);
  assert.equal(r.rtmsUserFor('uuid-ana'), 1);
  assert.equal(r.zoomAppUuidFor(1), 'uuid-ana');
  assert.equal(r.rtmsUserFor('nobody'), null);
  const snap = r.finalize(50);
  assert.deepEqual(snap.participants[0].video, [{ from: 2, to: 50, closedBy: 'stream_end' }]);
  assert.deepEqual([snap.participant_schema_version, snap.stream_id, snap.tenant_id], ['1', 's1', 'acme']);
  assert.equal(snap.participants[0].zoom_app_participant_uuid, 'uuid-ana');
});

function subscriptionRig(options = {}) {
  const r = registry();
  const sent = [];
  const timers = [];
  const trace = createMemoryTrace();
  const m = createVideoSubscriptionManager({
    registry: r, send: (msg) => sent.push(msg), trace, streamId: 's1', ...options,
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; }, clearTimer: (t) => { t.cancelled = true; }
  });
  r.subscribe((c) => m.handleParticipantChange(c));
  r.handleEvent({ event_type: J, timestamp: 1, participants: people([1, 'Ana'], [2, 'Ben'], [3, 'Cy']) });
  for (const id of [1, 2, 3]) r.handleEvent({ event_type: VON, timestamp: 2, participants: people([id]) });
  const ok = (userId, subscribe = true) => m.handleResponse({ msg_type: MSG.VIDEO_SUBSCRIPTION_RESP, status_code: 0, user_id: userId, subscribe });
  return { r, m, sent, timers, trace, ok };
}

test('subscription: refuses someone whose video is off, sends one request at a time, switches by unsubscribe then subscribe', () => {
  const { r, m, sent, ok } = subscriptionRig();
  r.handleEvent({ event_type: VOFF, timestamp: 3, participants: people([3]) });
  assert.deepEqual(m.request(3), { ok: false, reason: 'video_not_on' });
  assert.equal(sent.length, 0);

  assert.equal(m.request(1).ok, true);
  assert.deepEqual(sent.map((s) => [s.user_id, s.subscribe]), [[1, true]]);
  assert.equal(m.request(2).reason, 'queued'); // user 1 is still in flight, so nothing more is sent
  assert.equal(sent.length, 1);
  ok(1);
  assert.equal(m.state().current, 1);
  // the next step is derived from current vs desired: release 1 first
  assert.deepEqual(sent.map((s) => [s.user_id, s.subscribe]), [[1, true], [1, false]]);
  ok(1, false);
  assert.deepEqual(sent.map((s) => [s.user_id, s.subscribe]), [[1, true], [1, false], [2, true]]);
  ok(2);
  assert.deepEqual([m.state().current, m.state().inflight], [2, null]);
  assert.equal(m.request(2).reason, 'already_selected');
  assert.equal(sent.length, 3);
});

test('subscription: a rejected subscribe leaves nobody selected; a timeout does not block the queue', () => {
  const { m, sent, timers } = subscriptionRig();
  m.request(1);
  m.handleResponse({ status_code: 30, user_id: 1, subscribe: true });
  assert.deepEqual([m.state().current, m.state().desired, m.state().stats.failed], [null, null, 1]);
  m.request(2);
  m.request(3); // changed our mind while 2 is in flight
  assert.equal(sent.length, 2);
  timers.at(-1).fn(); // the request for 2 is never answered, so the server may or may not have it
  assert.deepEqual(sent.map((s) => [s.user_id, s.subscribe]).slice(-1), [[2, false]], 'clean up the unknown first');
  m.handleResponse({ status_code: 0, user_id: 2, subscribe: false });
  assert.deepEqual(sent.map((s) => [s.user_id, s.subscribe]).slice(-1), [[3, true]]);
  assert.equal(m.handleResponse({ status_code: 0, user_id: 99, subscribe: true }).handled, false, 'an answer nobody asked for is ignored');
});

test('subscription: when the selected person turns video off or leaves, nothing is sent and the stream goes on', () => {
  const { r, m, sent, ok } = subscriptionRig();
  m.request(1);
  ok(1);
  r.handleEvent({ event_type: VOFF, timestamp: 5, participants: people([1]) });
  assert.deepEqual([m.state().current, m.state().desired], [null, null]);
  assert.equal(sent.length, 1, 'no unsubscribe: the server already ended it');
  assert.equal(m.attributeFrame({ userId: 1 }).attributed, false, 'no frames attributed to the departed');
  m.request(2);
  ok(2);
  r.handleEvent({ event_type: L, timestamp: 6, user_id: 2 });
  assert.equal(m.state().current, null);
});

test('subscription: afterVideoEnds next picks another person with video on', () => {
  const { r, m, sent, ok } = subscriptionRig({ afterVideoEnds: 'next' });
  m.request(1);
  ok(1);
  r.handleEvent({ event_type: VOFF, timestamp: 5, participants: people([1]) });
  assert.deepEqual(sent.at(-1), { ...sent.at(-1), user_id: 2, subscribe: true });
});

test('subscription: a queued subscribe is dropped if the person turned video off while waiting', () => {
  const { r, m, sent, ok } = subscriptionRig();
  m.request(1);
  m.request(2);
  r.handleEvent({ event_type: VOFF, timestamp: 4, participants: people([2]) });
  ok(1);
  assert.equal(sent.some((s) => s.user_id === 2 && s.subscribe), false);
  assert.equal(sent.length, 1, 'no churn: user 1 stays selected');
  assert.deepEqual([m.state().current, m.state().desired, m.state().stats.refused], [1, 1, 1]);
});

test('subscription: a video socket reconnect re-subscribes the person we wanted', () => {
  const { m, sent, ok } = subscriptionRig();
  m.request(2);
  ok(2);
  assert.deepEqual(m.handleVideoSocketRecovered(), { resubscribed: true, userId: 2 });
  assert.deepEqual(sent.at(-1), { ...sent.at(-1), user_id: 2, subscribe: true });
  assert.equal(m.state().stats.resubscribes, 1);
  const none = subscriptionRig();
  assert.deepEqual(none.m.handleVideoSocketRecovered(), { resubscribed: false });
  assert.deepEqual(none.m.attributeFrame({ userId: 5 }), { attributed: false, userId: null });
});

test('media profile: valid params, stereo needs Opus, ranges are enforced', () => {
  const a = buildMediaParams('audio', {});
  assert.deepEqual(a.params, DEFAULT_MEDIA_PARAMS.audio);
  assert.ok(buildMediaParams('audio', { channels: 'stereo' }).errors[0].includes('Opus'));
  const stereo = buildMediaParams('audio', { codec: 'opus', channels: 'stereo', sampleRate: 48000 });
  assert.deepEqual([stereo.errors.length, stereo.params.channel, stereo.params.codec, stereo.params.sample_rate], [0, 2, 4, 3]);
  assert.ok(buildMediaParams('audio', { sampleRate: 44100 }).errors.length);
  assert.ok(buildMediaParams('audio', { perParticipant: true }).warnings[0].includes('Validate'));
  assert.equal(buildMediaParams('audio', { perParticipant: true }).params.data_opt, 2);

  const v = buildMediaParams('video', {});
  assert.deepEqual(v.params, DEFAULT_MEDIA_PARAMS.video);
  const ind = buildMediaParams('video', { mode: 'individual', fps: 15 });
  assert.deepEqual([ind.params.data_opt, ind.params.fps], [4, 15]);
  assert.ok(ind.warnings.some((w) => w.includes('ONE selected')));
  assert.ok(buildMediaParams('video', { fps: 60 }).errors.length);
  assert.ok(buildMediaParams('video', { mode: 'all' }).errors.length);
  assert.deepEqual(buildMediaParams('transcript').params, { content_type: 5, src_language: 9, enable_lid: true });
  assert.deepEqual(buildMediaParams('transcript', { languageId: 28, detectLanguage: false }).params, { content_type: 5, src_language: 28, enable_lid: false });
  assert.ok(buildMediaParams('transcript', { languageId: -1 }).errors.length);
  assert.deepEqual(buildMediaParams('chat').params, { content_type: 5 });
  assert.ok(buildMediaParams('chat').warnings[0].includes('receive-only'));
  assert.ok(buildMediaParams('hologram').errors.length);
  assert.equal(buildMediaParams('share').params.fps, 1);
  assert.ok(buildMediaParams('video', { codec: 'png' }).errors[0].includes('V2'));
  assert.ok(buildMediaParams('share', { codec: 'png' }).errors[0].includes('V2'));
  assert.ok(buildMediaParams('share', { fps: 60 }).errors.length);
});

test('media profile: translates what a Meeting SDK bot consumed', () => {
  const r = fromSdkRaw({ audio: { sampleRate: 44100, channels: 1 }, video: { format: 'YUV420', width: 1920, height: 1080, fps: 30 } });
  assert.equal(r.audio.params.sample_rate, 3, '44.1 kHz maps to 48 kHz');
  assert.equal(r.video.params.resolution, 3);
  assert.ok(r.notes.some((n) => n.includes('resample')));
  assert.ok(r.notes.some((n) => n.includes('YUV420')));
  const st = fromSdkRaw({ audio: { sampleRate: 48000, channels: 2 } });
  assert.deepEqual([st.audio.params.codec, st.audio.params.channel], [4, 2]);
});
