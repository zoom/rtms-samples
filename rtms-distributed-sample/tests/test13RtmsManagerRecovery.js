import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import { handleSignalingMessage } from '../../library/javascript/rtmsManager/signalingSocketMessageHandler.js';

testInterruptedWebhookReconnectsOwnedStream();
testMediaInterruptionEmitsDedicatedEvent();

console.log('13 RTMSManager recovery tester passed: 2/2');

function testInterruptedWebhookReconnectsOwnedStream() {
  const manager = new RTMSManager({ logger: testLogger() });
  let reconnects = 0;
  manager.connectionManager.add('recovery-stream', {
    streamId: 'recovery-stream',
    rtmsId: 'recovery-meeting',
    rtmsType: 'meeting',
    reconnect() {
      reconnects += 1;
    }
  });

  manager.emit('meeting.rtms_interrupted', {
    meeting_uuid: 'recovery-meeting',
    rtms_stream_id: 'recovery-stream'
  });

  assert(reconnects === 1, 'interrupted webhook did not reconnect the owned stream');
  pass('interrupted_webhook_reconnects_owned_stream');
}

function testMediaInterruptionEmitsDedicatedEvent() {
  const events = [];
  handleSignalingMessage(
    Buffer.from(JSON.stringify({
      msg_type: 6,
      event: {
        event_type: 7,
        timestamp: 1779460000000
      }
    })),
    'media-recovery-meeting',
    'media-recovery-stream',
    {},
    {
      rtmsType: 'meeting',
      config: {}
    },
    (name, event) => events.push({ name, event }),
    32,
    'client-id',
    'client-secret'
  );

  const mediaInterrupted = events.find((entry) => entry.name === 'media_connection_interrupted');
  const genericEvent = events.find((entry) => entry.name === 'event');

  assert(mediaInterrupted?.event?.streamId === 'media-recovery-stream', 'media interruption event was not emitted');
  assert(genericEvent?.event?.eventType === 7, 'generic RTMS media interruption event was not preserved');
  pass('media_interruption_emits_dedicated_event');
}

function testLogger() {
  return {
    error() {},
    info() {},
    log() {},
    warn() {}
  };
}

function pass(name) {
  console.log(`PASS ${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
