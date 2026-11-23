import assert from 'node:assert/strict';
import test from 'node:test';

import { RTMSManager } from '../RTMSManager.js';
import { RTMSMessageHandler } from '../RTMSMessageHandler.js';
import { handleMediaMessage } from '../mediaSocketMessageHandler.js';
import { handleSignalingMessage, RTMS_EVENT_CODES } from '../signalingSocketMessageHandler.js';
import { getPreferredMediaUrl } from '../utils/rtmsEntityHelper.js';
import { selectAllowedRtmsCallbackUrl } from '../utils/rtmsUrlPolicy.js';

function createPhoneHandler(config = {}) {
  // Build a handler without connecting sockets; the constructor calls connect().
  const original = RTMSMessageHandler.prototype.connect;
  RTMSMessageHandler.prototype.connect = () => {};
  try {
    return new RTMSMessageHandler(
      'call-1',
      'stream-1',
      'wss://signal.zoom.us/ws',
      'client-id',
      'client-secret',
      () => true,
      RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT,
      { asyncMediaEvents: false, ...config },
      'phone'
    );
  } finally {
    RTMSMessageHandler.prototype.connect = original;
  }
}

function capture() {
  const events = [];
  return { events, emit: (name, payload) => events.push({ name, payload }) };
}

test('selects the wss URL from a comma-separated Phone server_urls value', () => {
  assert.equal(
    selectAllowedRtmsCallbackUrl('srt://media.zoom.us:9000, wss://signal.zoom.us/ws'),
    'wss://signal.zoom.us/ws'
  );
  assert.equal(selectAllowedRtmsCallbackUrl('srt://media.zoom.us:9000'), undefined);
  assert.equal(
    getPreferredMediaUrl('phone', { transcript: 'wss://t.zoom.us/ws,srt://t.zoom.us:1' }, 'transcript'),
    'wss://t.zoom.us/ws'
  );
});

test('Phone streams always use protocol V2 or later', () => {
  assert.equal(createPhoneHandler().protocolVersion, 2);
  assert.equal(createPhoneHandler({ protocolVersion: 1 }).protocolVersion, 2);
  assert.equal(createPhoneHandler({ protocolVersion: 3 }).protocolVersion, 3);
  assert.equal(RTMSManager.PRESETS.PHONE.mediaTypes, RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT);
});

test('CALL_INFO_UPDATED stores participants and names later transcript turns', () => {
  const handler = createPhoneHandler();
  const signaling = capture();
  handleSignalingMessage(
    JSON.stringify({
      msg_type: 'EVENT_UPDATE',
      event: {
        event_code: RTMS_EVENT_CODES.ZP_CALL_INFO_UPDATED,
        host_channel_id: 'ch-a',
        participants: [
          { name: 'Alice', 'phone_number/extension_number': '1001', channel_id: 'ch-a' },
          { name: 'pstn', 'phone_number/extension_number': '+6512345678', channel_id: 'ch-b' }
        ],
        timestamp: 1
      }
    }),
    'call-1', 'stream-1', { send() {} }, handler, signaling.emit, 9, 'client-id', 'client-secret'
  );

  const infoEvent = signaling.events.find((event) => event.name === 'phone_call_info_updated');
  assert.equal(infoEvent.payload.hostChannelId, 'ch-a');
  assert.deepEqual(infoEvent.payload.participants[1], { channelId: 'ch-b', name: 'pstn', number: '+6512345678' });
  assert.equal(signaling.events.find((event) => event.name === 'event').payload.eventCode, 3000);

  const media = capture();
  handleMediaMessage(
    JSON.stringify({
      msg_type: 17,
      content: {
        channel_id: 'ch-a',
        attribute: 2,
        language: 9,
        data: 'Your support case has been updated.',
        timestamp: 3,
        start_time: 1,
        end_time: 2,
        sentence_id: 0
      }
    }),
    { conn: handler, mediaWs: {}, signalingSocket: {}, meetingUuid: 'call-1', streamId: 'stream-1', mediaType: 'transcript', emit: media.emit }
  );

  const transcript = media.events.find((event) => event.name === 'transcript').payload;
  assert.equal(transcript.userId, 'ch-a');
  assert.equal(transcript.userName, 'Alice');
  assert.equal(transcript.channelId, 'ch-a');
  assert.equal(transcript.sentenceId, 0);
  assert.equal(transcript.isUpdate, true);
  assert.equal(transcript.productType, 'phone');
});

test('Phone hold, resume, and transfer events are emitted by name', () => {
  const handler = createPhoneHandler();
  const signaling = capture();
  const send = (event) => handleSignalingMessage(
    JSON.stringify({ msg_type: 6, event }),
    'call-1', 'stream-1', { send() {} }, handler, signaling.emit, 9, 'client-id', 'client-secret'
  );

  send({ event_code: RTMS_EVENT_CODES.ZP_CALL_HOLD, timestamp: 1 });
  send({ event_code: RTMS_EVENT_CODES.ZP_CALL_RESUME, timestamp: 2 });
  send({
    event_code: RTMS_EVENT_CODES.ZP_CALL_TRANSFER_COMPLETED,
    transfer_type: 'MEETING',
    transfer_result: { meeting_uuid: 'meeting-1' },
    timestamp: 3
  });

  const names = signaling.events.map((event) => event.name).filter((name) => name !== 'event');
  assert.deepEqual(names, ['phone_call_hold', 'phone_call_resume', 'phone_call_transfer_completed']);
  const transfer = signaling.events.find((event) => event.name === 'phone_call_transfer_completed').payload;
  assert.equal(transfer.transferType, 'MEETING');
  assert.equal(transfer.transferResult.meeting_uuid, 'meeting-1');
});
