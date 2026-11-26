import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  createAuthorizeRegistration,
  decryptZoomAppContext,
  encryptZoomAppContext,
  mintTokenFromZoomAppHeader,
  verifyWsRegistrationToken
} from '../wsAuth.js';
import {
  ChatSessionManager,
  isLikelyAcousticEcho,
  matchWakeWord
} from '../chatSessionManager.js';
import { chatWithOpenRouter, DEFAULT_OPENROUTER_MODEL } from '../chatWithOpenrouter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadAudioClient({ WebSocket, AudioContext }) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'audio-client.js'), 'utf8');
  const sandbox = {
    WebSocket,
    window: { AudioContext },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Uint8Array,
    Int16Array,
    Float32Array,
    Set,
    Promise,
    Error,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    console,
    setTimeout,
    clearTimeout,
    module: { exports: {} }
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports.AudioClient;
}

test('wsAuth: decrypts Zoom App context header and authorizes pre-RTMS registration via HMAC token', async () => {
  const clientSecret = 'super-secret-client-key';
  const signingSecret = 'super-secret-signing-key';
  const header = encryptZoomAppContext({ mid: 'meeting-abc', uid: 'user-1', typ: 'inMeeting' }, clientSecret);

  const decrypted = decryptZoomAppContext(header, clientSecret);
  assert.equal(decrypted.mid, 'meeting-abc');
  assert.equal(decrypted.uid, 'user-1');
  assert.equal(decryptZoomAppContext(header, 'wrong-secret'), null);

  const token = mintTokenFromZoomAppHeader(header, { clientSecret, signingSecret });
  assert.ok(token.includes('.'));

  const validCheck = verifyWsRegistrationToken(token, { expectedMeetingUUID: 'meeting-abc', secret: signingSecret });
  assert.equal(validCheck.valid, true);

  const wrongMeetingCheck = verifyWsRegistrationToken(token, { expectedMeetingUUID: 'meeting-other', secret: signingSecret });
  assert.equal(wrongMeetingCheck.valid, false);

  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'active-meeting' }],
    authToken: 'static-dev-token',
    signingSecret,
    allowPreRtms: false
  });

  // 1. Active RTMS connection
  assert.equal((await authorize({ meetingUUID: 'active-meeting', userID: 'u1' })).authorized, true);
  // 2. Static auth token
  assert.equal((await authorize({ meetingUUID: 'any-meeting', userID: 'u1', token: 'static-dev-token' })).authorized, true);
  // 3. Valid HMAC token from x-zoom-app-context
  assert.equal((await authorize({ meetingUUID: 'meeting-abc', userID: 'u1', token })).authorized, true);
  // 4. Reject unknown meeting with bad token
  assert.equal((await authorize({ meetingUUID: 'unknown-meeting', userID: 'u1', token: 'bad' })).authorized, false);
});

test('chatSessionManager: wake-word gating, push-to-talk, echo suppression, rewind dedup, and history cap', () => {
  const manager = new ChatSessionManager({
    defaultMode: 'wake_word',
    defaultWakeWords: ['hey ai'],
    maxHistoryMessages: 4,
    echoCooldownMs: 2000,
    echoWindowMs: 10000
  });

  // Wake word extraction
  assert.deepEqual(matchWakeWord('Hey AI, summarize our sprint', ['hey ai']), {
    matched: true,
    prompt: 'summarize our sprint',
    wakeWord: 'hey ai'
  });
  assert.equal(matchWakeWord('Just chatting with teammates', ['hey ai']).matched, false);

  // Regular speech without wake word is suppressed
  const ignored = manager.handleTranscriptEvent({
    meetingId: 'm1',
    streamId: 's1',
    userId: 'u1',
    userName: 'Alice',
    sentenceId: 1,
    text: 'Let us check the calendar',
    timestamp: 1000
  }, { now: 1000 });
  assert.equal(ignored.shouldReply, false);
  assert.equal(ignored.suppressedReason, 'no_wake_word');

  // Wake word triggers reply
  const triggered = manager.handleTranscriptEvent({
    meetingId: 'm1',
    streamId: 's1',
    userId: 'u1',
    userName: 'Alice',
    sentenceId: 2,
    text: 'Hey AI, what is Zoom RTMS?',
    timestamp: 2000
  }, { now: 2000 });
  assert.equal(triggered.shouldReply, true);
  assert.equal(triggered.promptText, 'what is Zoom RTMS?');

  // Rewind update on already-answered sentence updates text in place without re-triggering
  const rewind = manager.handleTranscriptEvent({
    meetingId: 'm1',
    streamId: 's1',
    userId: 'u1',
    userName: 'Alice',
    sentenceId: 2,
    isUpdate: true,
    attribute: 2,
    text: 'Hey AI, what is Zoom RTMS really?',
    timestamp: 2100
  }, { now: 2100 });
  assert.equal(rewind.revision.action, 'updated');
  assert.equal(rewind.shouldReply, false);
  assert.equal(rewind.suppressedReason, 'revision_already_answered');
  assert.equal(rewind.logItem.text, 'Hey AI, what is Zoom RTMS really?');

  // Record assistant reply and verify echo suppression
  manager.recordAssistantReply('m1', 'Zoom RTMS delivers real-time audio, video, and transcript streams.', {
    now: 3000,
    estimatedAudioMs: 2500
  });
  assert.equal(
    isLikelyAcousticEcho(
      'Zoom RTMS delivers real-time audio video and transcript streams',
      'Zoom RTMS delivers real-time audio, video, and transcript streams.',
      3000,
      { now: 7000, cooldownUntil: 5500, echoWindowMs: 10000 }
    ),
    true
  );

  // Switch to push-to-talk and verify arm/disarm behavior
  manager.updateSettings('m1', { mode: 'push_to_talk', pttArmed: true });
  const pttTurn = manager.handleTranscriptEvent({
    meetingId: 'm1',
    streamId: 's1',
    userId: 'u2',
    userName: 'Bob',
    sentenceId: 3,
    text: 'Tell me a fun fact',
    timestamp: 20000
  }, { now: 20000 });
  assert.equal(pttTurn.shouldReply, true);
  assert.equal(manager.getPublicState('m1').pttArmed, false);

  // Interrupt bumps epoch and aborts active AbortController
  const turn = manager.beginReplyTurn('m1');
  assert.equal(manager.isTurnCurrent('m1', turn.epoch), true);
  manager.interrupt('m1');
  assert.equal(turn.signal.aborted, true);
  assert.equal(manager.isTurnCurrent('m1', turn.epoch), false);

  // History stays bounded at maxHistoryMessages
  for (let i = 0; i < 6; i += 1) {
    manager.handleTypedMessage('m1', { text: `msg ${i}`, speaker: 'Alice' });
  }
  assert.ok(manager.getSession('m1').history.length <= 4);

  // Per-meeting cleanup
  manager.getOrCreateSession('m2');
  assert.equal(manager.clearSession('m1'), true);
  assert.equal(manager.getSession('m1'), null);
  assert.ok(manager.getSession('m2'));
});

test('chatWithOpenRouter: sends messages array, defaults model lazily, and rejects non-OK HTTP responses', async () => {
  let capturedBody = null;
  const mockFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Hello from AI!' } }] })
    };
  };

  const reply = await chatWithOpenRouter(
    [{ role: 'user', content: 'Hi there' }],
    { apiKey: 'test-key', fetchImpl: mockFetch }
  );
  assert.equal(reply, 'Hello from AI!');
  assert.equal(capturedBody.model, process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL);
  assert.equal(capturedBody.messages[0].role, 'system');
  assert.equal(capturedBody.messages[1].content, 'Hi there');

  await assert.rejects(
    () => chatWithOpenRouter('Hi', {
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' })
    }),
    /OpenRouter API error \(502\)/
  );
});

test('AudioClient: resolves connect() on open, decodes WAV, and resets isModelSpeaking when playback drains', async () => {
  const sent = [];
  let wsInstance = null;

  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      wsInstance = this;
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }
    send(payload) {
      sent.push(JSON.parse(payload));
    }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }

  let decodedCalled = false;
  let lastSource = null;
  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    async decodeAudioData() {
      decodedCalled = true;
      return { duration: 0.5 };
    }
    createBufferSource() {
      const src = {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {}
      };
      lastSource = src;
      return src;
    }
  }

  const AudioClient = loadAudioClient({ WebSocket: MockWebSocket, AudioContext: MockAudioContext });

  const client = new AudioClient('ws://localhost:3000/ws');
  let connectedFired = false;
  client.onConnected = () => { connectedFired = true; };

  await client.connect();
  assert.equal(connectedFired, true);
  assert.equal(client.isConnected, true);

  // Ping -> Pong
  await wsInstance.onmessage({ data: JSON.stringify({ type: 'ping' }) });
  assert.deepEqual(sent.at(-1), { type: 'pong' });

  // Fake RIFF/WAV base64 payload
  const fakeWavBase64 = Buffer.from('RIFF\x24\x00\x00\x00WAVE').toString('base64');
  await client.playAudio(fakeWavBase64, { format: 'wav' });
  assert.equal(decodedCalled, true);
  assert.equal(client.isModelSpeaking, true);

  // When audio buffer finishes, isModelSpeaking resets to false
  lastSource.onended();
  assert.equal(client.isModelSpeaking, false);

  client.close();
});
