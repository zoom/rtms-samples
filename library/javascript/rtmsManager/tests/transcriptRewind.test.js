import assert from 'node:assert/strict';
import test from 'node:test';

import { RTMSManager } from '../RTMSManager.js';
import { RTMSMessageHandler } from '../RTMSMessageHandler.js';
import { handleMediaMessage } from '../mediaSocketMessageHandler.js';
import { TranscriptRevisionStore } from '../index.js';

function createMeetingHandler() {
  // Build a handler without connecting sockets; the constructor calls connect().
  const original = RTMSMessageHandler.prototype.connect;
  RTMSMessageHandler.prototype.connect = () => {};
  try {
    return new RTMSMessageHandler(
      'meeting-1', 'stream-1', 'wss://signal.zoom.us/ws', 'client-id', 'client-secret',
      () => true, RTMSManager.MEDIA.TRANSCRIPT, { asyncMediaEvents: false }, 'meeting'
    );
  } finally {
    RTMSMessageHandler.prototype.connect = original;
  }
}

function transcriptEvents(contents) {
  const conn = createMeetingHandler();
  const events = [];
  for (const content of contents) {
    handleMediaMessage(JSON.stringify({ msg_type: 17, content }), {
      conn, mediaWs: {}, signalingSocket: {}, meetingUuid: 'meeting-1', streamId: 'stream-1',
      mediaType: 'transcript', emit: (name, payload) => name === 'transcript' && events.push(payload)
    });
  }
  return events;
}

test('meeting transcript events expose rewind fields', () => {
  const [first, revision] = transcriptEvents([
    { user_id: 16778240, user_name: 'Ana', sentence_id: 0, attribute: 1, data: 'Hello ward', start_time: 10, end_time: 20 },
    { user_id: 16778240, user_name: 'Ana', sentence_id: 0, attribute: '2', data: 'Hello world', start_time: 10, end_time: 25 }
  ]);
  assert.equal(first.sentenceId, 0);
  assert.equal(first.isUpdate, false);
  assert.equal(revision.sentenceId, 0);
  assert.equal(revision.isUpdate, true);
  assert.equal(revision.productType, 'meeting');
});

test('TranscriptRevisionStore replaces revised sentences in place', () => {
  const store = new TranscriptRevisionStore();
  const events = transcriptEvents([
    { user_id: 1, user_name: 'Ana', sentence_id: 7, attribute: 1, data: 'Hello ward', start_time: 10 },
    { user_id: 2, user_name: 'Ben', sentence_id: 7, attribute: 1, data: 'Hi', start_time: 20 },
    { user_id: 1, user_name: 'Ana', sentence_id: 7, attribute: 2, data: 'Hello world', start_time: 10 },
    { user_id: 1, user_name: 'Ana', data: 'No sentence id', start_time: 30 }
  ]);
  assert.deepEqual(events.map((event) => store.apply(event).action), ['new', 'new', 'updated', 'new']);
  assert.deepEqual(store.sentences('stream-1').map((s) => s.text), ['Hello world', 'Hi', 'No sentence id']);
  assert.equal(store.sentences()[0].revision, 1);

  // A revision without a known original (for example after a reconnect) is kept.
  assert.equal(store.apply({ streamId: 'stream-1', userId: 3, sentenceId: 1, isUpdate: true, text: 'Late' }).action, 'recovered');
  // Phone sentence IDs repeat across channels.
  assert.equal(store.apply({ streamId: 'call', channelId: 'a', sentenceId: 0, text: 'A' }).action, 'new');
  assert.equal(store.apply({ streamId: 'call', channelId: 'b', sentenceId: 0, text: 'B' }).action, 'new');

  store.clear('stream-1');
  assert.deepEqual(store.sentences().map((s) => s.text), ['A', 'B']);
});
