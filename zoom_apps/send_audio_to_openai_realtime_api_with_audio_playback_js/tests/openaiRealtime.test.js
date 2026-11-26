import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { createResamplerState, resamplePcm16Mono } from '../audioResampler.js';
import {
  decryptZoomAppContext,
  mintFrontendWsToken,
  createAuthorizeRegistration,
} from '../frontendAuth.js';
import {
  getSession,
  sessions,
  buildSessionUpdateEvent,
  sendTextMessageToRealtime,
  shouldSuppressMicAudio,
  normalizeUsage,
  estimateUsageCost,
  parseMcpServers,
  cleanupMeeting,
} from '../openaiRealtime.js';

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

test('FIR half-band decimation eliminates aliasing at 48k -> 24k', () => {
  const passIn = generateSinePcm16(48000, 1000, 4800);
  const passOut = resamplePcm16Mono(passIn, 48000, 24000, createResamplerState());
  const inRms = measureRms(passIn);
  const passRms = measureRms(passOut);
  assert.ok(passRms / inRms > 0.95);

  const stopIn = generateSinePcm16(48000, 18000, 4800);
  const stopOut = resamplePcm16Mono(stopIn, 48000, 24000, createResamplerState());
  const stopRms = measureRms(stopOut);
  const attenuationDb = 20 * Math.log10(inRms / Math.max(1e-6, stopRms));
  assert.ok(attenuationDb > 40, `Expected > 40 dB stopband attenuation, got ${attenuationDb.toFixed(1)} dB`);
});

test('Frontend WSS authorization enforces meeting scoping', async () => {
  const clientSecret = 'secret-1';
  const signingSecret = 'sign-1';
  const header = encryptZoomAppContext({ mid: 'm-openai', uid: 'u1', exp: Date.now() + 60_000 }, clientSecret);
  const token = mintFrontendWsToken(decryptZoomAppContext(header, clientSecret), signingSecret);

  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'm-live' }],
    signingSecret,
    staticAuthToken: '',
    allowPreRtmsRegistration: false,
  });

  assert.equal((await authorize({ meetingUUID: 'm-live', userID: 'u1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-openai', userID: 'u1', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'm-wrong', userID: 'u1', token })).authorized, false);
});

test('OpenAI Realtime session: no cross-meeting fallback, hybrid text sends item+response, usage/cost telemetry, Speaker-Safe, and CONNECTING cleanup', async () => {
  const sent = [];
  let terminated = false;

  sessions.set('m-1', {
    meetingUuid: 'm-1',
    sessionReady: true,
    stopRequested: false,
    sourceAudioBuffer: [],
    queuedAudio: [],
    queuedAudioBytes: 0,
    ignoredErrorEventIds: new Set(),
    speakerSafeMode: true,
    clientPlaybackActive: false,
    assistantAudioTailUntil: Date.now() + 5000,
    ws: {
      readyState: 1,
      send(payload) { sent.push(JSON.parse(payload)); },
      close() {},
      terminate() { terminated = true; },
    },
    usage: { responses: 0, inputTokens: 0, outputTokens: 0, audioInputTokens: 0, textInputTokens: 0, audioOutputTokens: 0, textOutputTokens: 0, cachedInputTokens: 0, estimatedModelCostUsd: 0 },
  });

  // Strict meeting scoping
  assert.equal(getSession('m-other'), null);
  assert.equal(getSession(null), null);

  // Speaker-Safe tail cooldown suppresses mic
  assert.equal(shouldSuppressMicAudio(getSession('m-1')), true);

  // Hybrid text prompt sends conversation.item.create + response.create
  const ok = sendTextMessageToRealtime('Summarize the action items', 'm-1');
  assert.equal(ok, true);
  assert.equal(sent[0].type, 'conversation.item.create');
  assert.equal(sent[0].item.content[0].text, 'Summarize the action items');
  assert.equal(sent[1].type, 'response.create');

  // Session update configures server VAD with create_response: true
  const update = buildSessionUpdateEvent('m-1');
  assert.equal(update.session.audio.input.turn_detection.create_response, true);

  // Usage & cost estimation
  const normalized = normalizeUsage({
    input_tokens: 1500,
    output_tokens: 500,
    input_token_details: { audio_tokens: 1000, text_tokens: 500, cached_tokens: 100 },
    output_token_details: { audio_tokens: 400, text_tokens: 100 },
  });
  assert.equal(normalized.audioInputTokens, 1000);
  assert.equal(normalized.textOutputTokens, 100);
  const cost = estimateUsageCost(normalized);
  assert.ok(cost > 0);

  // MCP server parsing
  const servers = parseMcpServers(JSON.stringify([
    { id: 'stocks', url: 'https://mcp.stockmarketscan.com/mcp', authType: 'none', allowedTools: ['get_stock_info'] },
  ]));
  assert.equal(servers.length, 1);
  assert.throws(() => parseMcpServers(JSON.stringify([
    { id: 'bad', url: 'http://insecure.example.com', authType: 'none', allowedTools: ['foo'] },
  ])), /HTTPS/);

  // cleanupMeeting closes CONNECTING socket
  sessions.get('m-1').ws.readyState = 0;
  await cleanupMeeting('m-1');
  assert.equal(terminated, true);
  assert.equal(getSession('m-1'), null);
});
