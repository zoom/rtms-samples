import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createResamplerState, resamplePcm16Mono } from '../audioResampler.js';
import {
  decryptZoomAppContext,
  mintFrontendWsToken,
  verifyFrontendWsToken,
  createAuthorizeRegistration,
} from '../frontendAuth.js';
import {
  getSession,
  sessions,
  truncateRealtimeAudioPlayback,
  shouldSuppressMicAudio,
  cleanupMeeting,
  buildSessionUpdateEvent,
} from '../microsoftVoiceLive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function generateSinePcm16(sampleRate, freqHz, numSamples, amplitude = 20000) {
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function measureRms(buf, skipSamples = 32) {
  const total = buf.length / 2;
  let sumSq = 0;
  let count = 0;
  for (let i = skipSamples; i < total - skipSamples; i += 1) {
    const s = buf.readInt16LE(i * 2);
    sumSq += s * s;
    count += 1;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

function encryptZoomAppContext(payloadObj, secret) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from('aad', 'utf8');
  const key = crypto.createHash('sha256').update(secret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payloadObj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ivLen = Buffer.from([iv.length]);
  const aadLen = Buffer.alloc(2);
  aadLen.writeUInt16LE(aad.length, 0);
  const ctLen = Buffer.alloc(4);
  ctLen.writeUInt32LE(ct.length, 0);
  return Buffer.concat([ivLen, iv, aadLen, aad, ctLen, ct, tag]).toString('base64');
}

test('FIR half-band decimation preserves passband (1 kHz) and strongly attenuates alias-band (18 kHz) at 48k -> 24k', () => {
  const passbandIn = generateSinePcm16(48000, 1000, 4800);
  const passbandOut = resamplePcm16Mono(passbandIn, 48000, 24000, createResamplerState());
  assert.equal(passbandOut.length, 2400 * 2);

  const inRms = measureRms(passbandIn);
  const passOutRms = measureRms(passbandOut);
  assert.ok(passOutRms / inRms > 0.95, `Expected passband gain > 0.95, got ${passOutRms / inRms}`);

  // 18 kHz is above 12 kHz Nyquist of 24 kHz output -> must be heavily attenuated (> 40 dB)
  const stopbandIn = generateSinePcm16(48000, 18000, 4800);
  const stopbandOut = resamplePcm16Mono(stopbandIn, 48000, 24000, createResamplerState());
  const stopOutRms = measureRms(stopbandOut);
  const attenuationDb = 20 * Math.log10(inRms / Math.max(1e-6, stopOutRms));
  assert.ok(attenuationDb > 40, `Expected stopband attenuation > 40 dB, got ${attenuationDb.toFixed(1)} dB`);
});

test('Stateful FIR decimation across chunk boundaries matches continuous single-buffer decimation', () => {
  const full = generateSinePcm16(48000, 1200, 4800);
  const continuous = resamplePcm16Mono(full, 48000, 24000, createResamplerState());

  const state = createResamplerState();
  const part1 = resamplePcm16Mono(full.subarray(0, 2400 * 2), 48000, 24000, state);
  const part2 = resamplePcm16Mono(full.subarray(2400 * 2), 48000, 24000, state);
  const combined = Buffer.concat([part1, part2]);

  assert.deepEqual(combined, continuous);
});

test('Frontend WSS authorization enforces meeting isolation, HMAC context tokens, static tokens, and active RTMS connections', async () => {
  const clientSecret = 'zoom-client-secret-abc';
  const signingSecret = 'ws-signing-secret-xyz';
  const ctxHeader = encryptZoomAppContext({ mid: 'meet-1', uid: 'u1', exp: Date.now() + 60_000 }, clientSecret);
  const decoded = decryptZoomAppContext(ctxHeader, clientSecret);
  assert.equal(decoded.mid, 'meet-1');

  const minted = mintFrontendWsToken(decoded, signingSecret);
  assert.equal(verifyFrontendWsToken(minted, signingSecret).mid, 'meet-1');

  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'active-meet' }],
    signingSecret,
    staticAuthToken: 'static-secret-token',
    allowPreRtmsRegistration: false,
  });

  // 1. Active RTMS connection match
  assert.equal((await authorize({ meetingUUID: 'active-meet', userID: 'u1' })).authorized, true);
  // 2. Valid static token
  assert.equal((await authorize({ meetingUUID: 'any-meet', userID: 'u1', token: 'static-secret-token' })).authorized, true);
  // 3. Valid HMAC token matching meeting
  assert.equal((await authorize({ meetingUUID: 'meet-1', userID: 'u1', token: minted })).authorized, true);
  // 4. HMAC token for different meeting rejected
  assert.equal((await authorize({ meetingUUID: 'meet-other', userID: 'u1', token: minted })).authorized, false);
  // 5. Missing auth & no active connection rejected
  assert.equal((await authorize({ meetingUUID: 'unknown-meet', userID: 'u1' })).authorized, false);
});

test('Voice Live session lookup has no cross-meeting fallback, reconciles auto_truncate, supports Speaker-Safe, and closes CONNECTING sockets', async () => {
  const sentEvents = [];
  let terminated = false;

  sessions.set('meet-A', {
    meetingUuid: 'meet-A',
    ws: {
      readyState: 1, // OPEN
      send(payload) { sentEvents.push(JSON.parse(payload)); },
      close() {},
      terminate() { terminated = true; },
    },
    stopRequested: false,
    sourceAudioBuffer: [],
    queuedAudio: [],
    queuedAudioBytes: 0,
    ignoredErrorEventIds: new Set(),
    speakerSafeMode: true,
    clientPlaybackActive: true,
    assistantAudioTailUntil: 0,
  });

  // No cross-meeting fallback!
  assert.equal(getSession('meet-B'), null);
  assert.equal(getSession(null), null);
  assert.equal(getSession('meet-A')?.meetingUuid, 'meet-A');

  // Speaker-Safe suppresses mic while playing
  assert.equal(shouldSuppressMicAudio(getSession('meet-A')), true);

  // auto_truncate=true skips duplicate manual truncate on server-VAD barge-in (skipCancel=true)
  const skipped = truncateRealtimeAudioPlayback({
    meetingUuid: 'meet-A',
    itemId: 'item-1',
    audioEndMs: 500,
    skipCancel: true,
  });
  assert.equal(skipped, false);
  assert.equal(sentEvents.length, 0);

  // Manual interrupt (skipCancel=false) sends cancel + truncate
  const manual = truncateRealtimeAudioPlayback({
    meetingUuid: 'meet-A',
    responseId: 'resp-1',
    itemId: 'item-1',
    audioEndMs: 500,
    skipCancel: false,
  });
  assert.equal(manual, true);
  assert.ok(sentEvents.some((e) => e.type === 'conversation.item.truncate'));

  // Session update includes word timestamps
  const sessionUpdate = buildSessionUpdateEvent('meet-A');
  assert.deepEqual(sessionUpdate.session.output_audio_timestamp_types, ['word']);

  // cleanupMeeting terminates CONNECTING sockets cleanly
  sessions.get('meet-A').ws.readyState = 0; // CONNECTING
  await cleanupMeeting('meet-A');
  assert.equal(terminated, true);
  assert.equal(getSession('meet-A'), null);
});

test('microsoftVoiceLive.js contains zero leftover OpenAI Realtime string residue', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'microsoftVoiceLive.js'), 'utf8');
  assert.equal(src.includes('OpenAI Realtime'), false);
  assert.equal(src.includes('MCP_SERVERS_JSON'), false);
});
