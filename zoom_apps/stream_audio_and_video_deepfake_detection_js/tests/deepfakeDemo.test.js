import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import {
  SessionManager,
  computeCombinedTrustVerdict,
  createSocketAuthorizer,
  mintWsAuthToken
} from '../sessionManager.js';
import { AudioDeepfakeClient, DeepfakeClient, buildDecision, normalizeScores } from '../deepfakeClient.js';
import { HlsPipeline } from '../hlsPipeline.js';
import { AudioClipBuffer } from '../audioClipBuffer.js';

test('SessionManager isolates state per meeting and discards stale generation jobs on participant switch', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepfake-session-test-'));
  try {
    const manager = new SessionManager({
      hlsRootDir: path.join(tmpRoot, 'hls'),
      clipsRootDir: path.join(tmpRoot, 'clips'),
      createHlsPipeline: () => ({ started: false, stop() {}, hasLatestClip: () => false }),
      createAudioClipBuffer: () => ({ reset() {}, hasLatestClip: () => false })
    });

    const s1 = manager.bindStream('stream-1', 'meeting-A');
    const s2 = manager.bindStream('stream-2', 'meeting-B');
    assert.notEqual(s1.meetingKey, s2.meetingKey);

    s1.activeStreamId = 'stream-1';
    s1.selectedVideoUser = { userId: 101, userName: 'Alice' };
    const gen1 = s1.bumpSelectionGeneration();
    const job1 = { streamId: 'stream-1', userId: 101, selectionGeneration: gen1 };
    assert.equal(s1.isJobCurrent(job1), true);

    // Switch participant -> gen1 job must be rejected
    s1.bumpSelectionGeneration();
    s1.selectedVideoUser = { userId: 202, userName: 'Bob' };
    assert.equal(s1.isJobCurrent(job1), false);

    // Recording verification tracks rolling history and combined trust verdict
    const rec = s1.recordParticipantVerification(202, 'video', 'verified', { realScore: 0.92, fakeScore: 0.08 }, { userName: 'Bob' });
    assert.equal(rec.combined.status, 'partial');
    assert.equal(rec.history.video.length, 1);

    const rec2 = s1.recordParticipantVerification(202, 'audio', 'verified', { realScore: 0.88, fakeScore: 0.12 }, { userName: 'Bob' });
    assert.equal(rec2.combined.status, 'verified');
    assert.equal(rec2.combined.combinedRealScore, 0.9);
    assert.equal(rec2.history.audio.length, 1);

    manager.destroyAll();
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('computeCombinedTrustVerdict prioritizes deepfake alert over verified modality', () => {
  const alert = computeCombinedTrustVerdict(
    { status: 'verified', realScore: 0.9 },
    { status: 'deepfake', realScore: 0.1 }
  );
  assert.equal(alert.status, 'deepfake');
  assert.match(alert.label, /Audio/);
});

test('createSocketAuthorizer authorizes active RTMS, static token, and HMAC context token', () => {
  const signingKey = 'test-' + 'a'.repeat(12);
  const token = mintWsAuthToken({ mid: 'mtg-9', uid: 'u-9' }, signingKey, 60_000);
  const auth = createSocketAuthorizer({
    getActiveConnections: () => [{ rtmsId: 'mtg-live' }],
    staticAuthToken: 'static-key',
    signingSecret: signingKey,
    allowPreRtmsRegistration: false
  });

  assert.equal(auth({ meetingUUID: 'mtg-live', userID: 'u1' }).authorized, true);
  assert.equal(auth({ meetingUUID: 'mtg-9', userID: 'u9', token }).authorized, true);
  assert.equal(auth({ meetingUUID: 'mtg-other', userID: 'u9', token }).authorized, false);
  assert.equal(auth({ meetingUUID: 'mtg-x', userID: 'u1', token: 'static-key' }).authorized, true);
  assert.equal(auth({ meetingUUID: 'mtg-x', userID: 'u1', token: 'nope' }).authorized, false);
});

test('HlsPipeline prunes old MP4 clips to maxClips and cleans directory on stop', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-prune-test-'));
  try {
    const hlsDir = path.join(tmpRoot, 'hls');
    const clipDir = path.join(tmpRoot, 'clips');
    fs.mkdirSync(clipDir, { recursive: true });

    const pipeline = new HlsPipeline({
      hlsDir,
      clipDir,
      maxClips: 3,
      clipMinBytes: 10,
      clipStableAgeMs: 0
    });

    const now = Date.now() / 1000;
    for (let i = 0; i < 6; i++) {
      const p = path.join(clipDir, `clip_00${i}.mp4`);
      fs.writeFileSync(p, Buffer.alloc(64, i));
      fs.utimesSync(p, now - (10 - i), now - (10 - i));
    }

    const removed = pipeline.pruneOldClips();
    assert.equal(removed, 3);
    const remaining = fs.readdirSync(clipDir).filter((f) => f.endsWith('.mp4'));
    assert.equal(remaining.length, 3);

    pipeline.stop({ clean: true });
    assert.equal(fs.readdirSync(clipDir).filter((f) => f.endsWith('.mp4')).length, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('DeepfakeClient and AudioDeepfakeClient abort timed-out fetches and honor healthcheck flag', async () => {
  const server = http.createServer((_req, _res) => {
    // Intentionally hang without responding
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const videoClient = new DeepfakeClient({
      mode: 'service',
      serviceUrl: `http://127.0.0.1:${port}/video/classify`,
      apiKey: 'k',
      timeoutMs: 150
    });
    await assert.rejects(() => videoClient.checkHealth(), /timed out/i);

    const audioClientDisabledHealth = new AudioDeepfakeClient({
      mode: 'service',
      serviceUrl: `http://127.0.0.1:${port}/audio/classify`,
      apiKey: 'k',
      timeoutMs: 150,
      healthcheckEnabled: false
    });
    const skipped = await audioClientDisabledHealth.checkHealth();
    assert.equal(skipped.skipped, true);

    const scores = normalizeScores([{ label: 'bona_fide', score: 0.85 }, { label: 'spoof', score: 0.15 }]);
    const decision = buildDecision(scores, 0.75);
    assert.equal(decision.status, 'verified');
  } finally {
    server.close();
  }
});

test('AudioClipBuffer writes bounded PCM windows and resets cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-buf-test-'));
  try {
    const buf = new AudioClipBuffer({
      clipDir: tmpDir,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      clipSeconds: 1,
      maxClips: 2
    });
    // 1 second of 16kHz mono s16le = 32000 bytes
    const pcm = Buffer.alloc(32000, 0x10);
    const clip = buf.writeAudio(pcm, { streamId: 's1', userId: 42, userName: 'Alice' });
    assert.ok(clip);
    assert.equal(clip.userId, 42);
    assert.equal(buf.hasLatestClip(), true);

    buf.reset();
    assert.equal(buf.hasLatestClip(), false);
    assert.equal(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.pcm')).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
