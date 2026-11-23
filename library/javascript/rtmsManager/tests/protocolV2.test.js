import assert from 'node:assert/strict';
import test from 'node:test';

import { RTMSManager } from '../RTMSManager.js';
import { RTMSMessageHandler } from '../RTMSMessageHandler.js';
import { handleSignalingMessage } from '../signalingSocketMessageHandler.js';
import { RTMSFlagHelper } from '../utils/RTMSFlagHelper.js';

function createHandler(config = {}, rtmsType = 'meeting', mediaTypes = RTMSManager.MEDIA.AUDIO) {
  // Build a handler without connecting sockets; the constructor calls connect().
  const original = RTMSMessageHandler.prototype.connect;
  RTMSMessageHandler.prototype.connect = () => {};
  try {
    return new RTMSMessageHandler(
      'meeting-1',
      'stream-1',
      'wss://signal.zoom.us/ws',
      'client-id',
      'client-secret',
      () => true,
      mediaTypes,
      { asyncMediaEvents: false, ...config },
      rtmsType
    );
  } finally {
    RTMSMessageHandler.prototype.connect = original;
  }
}

function fakeSignalingSocket() {
  const sent = [];
  return { sent, readyState: 1, send: (data) => sent.push(JSON.parse(data)), close() {} };
}

function capture() {
  const events = [];
  return { events, emit: (name, payload) => events.push({ name, payload }) };
}

// Handshake OK with no media URLs, so no media sockets are opened and only
// the event subscription is sent.
function subscribe(handler, mediaTypes = RTMSManager.MEDIA.AUDIO) {
  const ws = fakeSignalingSocket();
  handleSignalingMessage(
    JSON.stringify({ msg_type: 2, protocol_version: handler.protocolVersion, status_code: 0, media_server: { server_urls: {} } }),
    'meeting-1', 'stream-1', ws, handler, () => true, mediaTypes, 'id', 'secret'
  );
  return ws.sent.find((msg) => msg.msg_type === 5);
}

test('meeting streams default to protocol V2 and can opt back into V1', () => {
  assert.equal(createHandler().protocolVersion, 2);
  assert.equal(createHandler({ protocolVersion: 1 }).protocolVersion, 1);
});

test('V2 subscriptions use event_code only and skip automatic events', () => {
  const payload = subscribe(createHandler({ subscribeAllKnownEvents: true }));
  const codes = payload.events.map((entry) => entry.event_code);
  assert.ok(payload.events.every((entry) => !('event_type' in entry)));
  assert.deepEqual(codes, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011]);
});

test('V2 default subscription maps active speaker, join, and leave', () => {
  const payload = subscribe(createHandler());
  assert.deepEqual(payload.events, [
    { event_code: 1000, subscribe: true },
    { event_code: 1001, subscribe: true },
    { event_code: 1002, subscribe: true }
  ]);
});

test('V1 subscriptions keep legacy event_type', () => {
  const payload = subscribe(createHandler({ protocolVersion: 1 }));
  assert.deepEqual(payload.events.map((entry) => entry.event_type), [2, 3, 4]);
  assert.ok(payload.events.every((entry) => !('event_code' in entry)));
});

test('V2 session event codes reach the legacy handlers and report both ids', () => {
  const handler = createHandler();
  const { events, emit } = capture();
  const ws = fakeSignalingSocket();
  const send = (event) => handleSignalingMessage(
    JSON.stringify({ msg_type: 6, event }), 'meeting-1', 'stream-1', ws, handler, emit, 1, 'id', 'secret'
  );

  send({ event_code: 1001, timestamp: 1, participants: [{ user_id: 7, user_name: 'Ada' }] });
  send({ event_code: 1005, timestamp: 2, participants: [{ user_id: 7, user_name: 'Ada' }] });
  send({ event_code: 1007, timestamp: 3 });
  send({ event_code: 2, timestamp: 4, media_type: 1 });
  send({ event_code: 3, timestamp: 5, connection_id: 'video-1' });

  const generic = events.filter((entry) => entry.name === 'event').map((entry) => entry.payload);
  assert.deepEqual(
    generic.map(({ eventType, eventCode }) => [eventType, eventCode]),
    [[3, 1001], [8, 1005], [10, 1007], [7, 2], [15, 3]]
  );
  assert.ok(events.some((entry) => entry.name === 'participant_video_on'));
  assert.equal(events.find((entry) => entry.name === 'chat_group_created').payload.eventCode, 1007);
  assert.equal(events.find((entry) => entry.name === 'media_connection_interrupted').payload.mediaType, 1);
  assert.equal(events.find((entry) => entry.name === 'video_subscription_terminated').payload.connectionId, 'video-1');
});

test('V1 events still report the matching V2 event code', () => {
  const handler = createHandler({ protocolVersion: 1 });
  const { events, emit } = capture();
  handleSignalingMessage(
    JSON.stringify({ msg_type: 6, event: { event_type: 4, user_id: 7 } }),
    'meeting-1', 'stream-1', fakeSignalingSocket(), handler, emit, 1, 'id', 'secret'
  );
  const generic = events.find((entry) => entry.name === 'event').payload;
  assert.equal(generic.eventType, 4);
  assert.equal(generic.eventCode, 1002);
});

test('a single server_urls string serves every requested media type', () => {
  assert.equal(RTMSFlagHelper.calculateEffectiveFlags(1 | 2 | 8, 'wss://m.zoom.us/ws,srt://m.zoom.us:1'), 11);
  assert.equal(RTMSFlagHelper.calculateEffectiveFlags(1 | 2, { audio: 'wss://a.zoom.us' }), 1);
  assert.equal(RTMSFlagHelper.calculateEffectiveFlags(1, ''), 0);
});

test('REQUEST_ERROR_RESP surfaces an RTMSError with the V2 status', () => {
  const handler = createHandler();
  const { events, emit } = capture();
  handleSignalingMessage(
    JSON.stringify({ msg_type: 30, request_msg_type: 5, status_code: 57 }),
    'meeting-1', 'stream-1', fakeSignalingSocket(), handler, emit, 1, 'id', 'secret'
  );
  const error = events.find((entry) => entry.name === 'error').payload;
  assert.equal(error.zoomStatus ?? error.statusCode ?? 57, 57);
  assert.match(error.toShortString(), /event_code|INVALID_EVENT_CODE/i);
});
