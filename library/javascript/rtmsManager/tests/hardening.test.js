import assert from 'node:assert/strict';
import test from 'node:test';
import { FrontendWssManager } from '../FrontendWssManager.js';
import { RTMSManager } from '../RTMSManager.js';
import { RTMSMessageHandler } from '../RTMSMessageHandler.js';
import { mergeMediaConfig } from '../mediaSocket.js';
import { MediaEventDispatcher } from '../utils/MediaEventDispatcher.js';

const silentLogger = {
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {}
};

test('frontend registration fails closed without an authorizer', async () => {
  const manager = new FrontendWssManager({ logger: silentLogger });
  const result = await manager.validateRegistration({
    meetingUUID: 'meeting-1',
    userID: 'user-1'
  });

  assert.deepEqual(result, { authorized: false });
});

test('frontend registration uses canonical identity returned by authorizer', async () => {
  const manager = new FrontendWssManager({
    logger: silentLogger,
    authorizeRegistration: async ({ token }) => ({
      authorized: token === 'valid',
      meetingUUID: 'verified-meeting',
      userID: 'verified-user'
    })
  });
  const result = await manager.validateRegistration({
    meetingUUID: 'untrusted-meeting',
    userID: 'untrusted-user',
    token: 'valid'
  });

  assert.equal(result.authorized, true);
  assert.equal(result.meetingUUID, 'verified-meeting');
  assert.equal(result.userID, 'verified-user');
});

test('frontend broadcast excludes clients that have not registered', () => {
  const manager = new FrontendWssManager({ logger: silentLogger });
  const unauthorizedMessages = [];
  const authorizedMessages = [];
  manager.frontendClients.add({
    readyState: 1,
    send: (message) => unauthorizedMessages.push(message)
  });
  manager.frontendClients.add({
    readyState: 1,
    meetingUUID: 'meeting-1',
    userID: 'user-1',
    send: (message) => authorizedMessages.push(message)
  });

  manager.broadcastToFrontendClients({ type: 'test' });

  assert.equal(unauthorizedMessages.length, 0);
  assert.equal(authorizedMessages.length, 1);
});

test('split media configuration is merged instead of overwritten', () => {
  const audioConfig = mergeMediaConfig({}, { audio: { sample_rate: 1 } }, 'audio');
  const combinedConfig = mergeMediaConfig(audioConfig, { video: { fps: 25 } }, 'video');

  assert.deepEqual(combinedConfig, {
    audio: { sample_rate: 1 },
    video: { fps: 25 }
  });
});

test('media dispatcher bounds its queue and drops the oldest event', async () => {
  const emitted = [];
  const dispatcher = new MediaEventDispatcher({
    emit: (_eventName, value) => emitted.push(value),
    logger: silentLogger,
    maxQueueSize: 2
  });

  dispatcher.dispatch('video', 1);
  dispatcher.dispatch('video', 2);
  dispatcher.dispatch('video', 3);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(emitted, [2, 3]);
  assert.equal(dispatcher.droppedEvents, 1);
});

test('manager stop waits for handler shutdown before resolving', async () => {
  const manager = new RTMSManager({ logger: silentLogger });
  manager._state = 'STARTED';
  let stopped = false;
  manager.connectionManager.add('stream-1', {
    rtmsType: 'meeting',
    rtmsId: 'meeting-1',
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stopped = true;
    }
  });

  await manager.stop();

  assert.equal(stopped, true);
  assert.equal(manager.connectionManager.size, 0);
  assert.equal(manager._state, 'STOPPED');
});

test('handler stop cancels reconnect timers and waits for socket closure', async () => {
  const handler = Object.create(RTMSMessageHandler.prototype);
  const reconnectTimer = setTimeout(() => {}, 10_000);
  const socket = {
    readyState: 1,
    listeners: new Map(),
    once(event, listener) {
      this.listeners.set(event, listener);
    },
    off(event, listener) {
      if (this.listeners.get(event) === listener) this.listeners.delete(event);
    },
    close() {
      setTimeout(() => {
        this.readyState = 3;
        this.listeners.get('close')?.();
      }, 20);
    },
    terminate() {}
  };
  Object.assign(handler, {
    streamId: 'stream-1',
    rtmsId: 'meeting-1',
    rtmsType: 'meeting',
    shouldReconnect: true,
    signaling: { socket },
    media: {
      video: {
        socket,
        reconnectTimer
      }
    },
    mediaEventDispatcher: { stop() {} },
    audioFiller: null,
    videoFiller: null,
    _signalingReconnectTimer: null,
    _duplicateSignalRetryTimer: null,
    _stopPromise: null
  });

  const startedAt = Date.now();
  await handler.stop();

  assert.equal(handler.media.video.reconnectTimer, null);
  assert.ok(Date.now() - startedAt >= 15);
});
