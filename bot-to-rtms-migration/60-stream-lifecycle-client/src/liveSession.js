import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MSG, TIMING } from '../../shared/codes.js';
import { createLogger } from '../../shared/log.js';
import { createParticipantRegistry } from '../../61-media-and-participants/src/participants.js';
import { createVideoSubscriptionManager } from '../../61-media-and-participants/src/videoSubscription.js';
import { buildMediaParams } from '../../61-media-and-participants/src/mediaProfile.js';
import { createStreamClient, DEFAULT_MEDIA_PARAMS } from './streamClient.js';
import { createTranscriptStore } from './transcriptStore.js';

const MEDIA = ['audio', 'video', 'share', 'transcript', 'chat'];
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
const number = (v, fallback) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

/** Everything a live session needs from the environment. Returns { config, errors }. */
export function readLiveConfig(env = process.env) {
  const errors = [];
  const media = String(env.RTMS_MEDIA || 'audio,transcript').split(',').map((s) => s.trim()).filter(Boolean);
  for (const m of media) if (!MEDIA.includes(m)) errors.push(`RTMS_MEDIA has "${m}". Use: ${MEDIA.join(', ')}`);
  if (!media.length) errors.push('RTMS_MEDIA is empty');
  const videoMode = env.RTMS_VIDEO_MODE || 'activeSpeaker';
  if (!['activeSpeaker', 'individual'].includes(videoMode)) errors.push('RTMS_VIDEO_MODE must be activeSpeaker or individual');
  const config = {
    media,
    videoMode,
    bufferData: truthy(env.RTMS_BUFFER_DATA),
    windows: {
      signalingMs: number(env.RTMS_SIGNALING_WINDOW_SEC, TIMING.signalingReconnectWindowMs / 1000) * 1000,
      mediaMs: number(env.RTMS_MEDIA_WINDOW_SEC, TIMING.mediaReconnectWindowMs / 1000) * 1000
    },
    reconnect: { baseMs: number(env.RTMS_RECONNECT_BASE_MS, 1000), capMs: number(env.RTMS_RECONNECT_CAP_MS, 15_000), maxAttempts: number(env.RTMS_RECONNECT_MAX_ATTEMPTS, 8) },
    outputDir: env.RTMS_OUTPUT_DIR || '.data/streams',
    saveTranscript: truthy(env.RTMS_SAVE_TRANSCRIPT),
    printTranscript: truthy(env.RTMS_PRINT_TRANSCRIPT),
    statsEverySec: number(env.RTMS_STATS_EVERY_SEC, 10),
    audio: { codec: env.RTMS_AUDIO_CODEC || 'l16', sampleRate: number(env.RTMS_AUDIO_SAMPLE_RATE, 16000), channels: env.RTMS_AUDIO_CHANNELS || 'mono' },
    video: { codec: 'h264', resolution: env.RTMS_VIDEO_RESOLUTION || 'hd', fps: number(env.RTMS_VIDEO_FPS, 25) },
    transcript: { languageId: number(env.RTMS_TRANSCRIPT_LANGUAGE_ID, 9), detectLanguage: env.RTMS_TRANSCRIPT_DETECT_LANGUAGE === undefined ? true : truthy(env.RTMS_TRANSCRIPT_DETECT_LANGUAGE) }
  };
  if (config.windows.signalingMs <= 0 || config.windows.mediaMs <= 0) errors.push('reconnect windows must be positive');
  return { config, errors };
}

/** media_params per concrete type, validated. Unrequested types keep the library defaults. */
export function liveMediaParams(config) {
  const params = { ...DEFAULT_MEDIA_PARAMS };
  const problems = [];
  for (const type of config.media) {
    const options = type === 'video' ? { ...config.video, mode: config.videoMode } : config[type] || {};
    const built = buildMediaParams(type, options);
    if (built.errors.length) problems.push(...built.errors.map((e) => `${type}: ${e}`));
    else params[type === 'share' ? 'deskshare' : type] = built.params;
  }
  return { params, problems };
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

/**
 * One real RTMS stream. It builds the stream client for the claimed stream, wires in the participant
 * registry and the video subscription manager from the media-and-participants folder, writes the stream
 * manifest when the stream ends, and reports progress as one JSON log line per event.
 *
 *   stream      what the start-and-approval service handed over: { tenantId, product, meetingId, streamId, generation, consentRef, policyVersion, startedAt, envelope }
 *   credentials { clientId, clientSecret }
 */
export function startLiveSession({ stream, credentials, config, trace, log = createLogger('live'), generation = null, outputRoot = config.outputDir, now = Date.now, onFinished = () => {} }) {
  const { params, problems } = liveMediaParams(config);
  if (problems.length) throw new Error(`invalid media settings: ${problems.join('; ')}`);
  if (!credentials?.clientId || !credentials?.clientSecret) throw new Error('ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are required to connect to RTMS');
  const serverUrls = stream.envelope?.serverUrls;
  if (!serverUrls) throw new Error('the started webhook has no server_urls');

  const dir = path.join(outputRoot, safe(stream.tenantId || 'unknown'), safe(stream.streamId));
  mkdirSync(dir, { recursive: true });
  const tag = { streamId: stream.streamId, meetingId: stream.meetingId };
  const registry = createParticipantRegistry({ tenantId: stream.tenantId, meetingId: stream.meetingId, streamId: stream.streamId });
  let manager;
  let client;
  const counts = { audio: 0, video: 0, share: 0, transcript: 0, chat: 0 };
  const transcripts = createTranscriptStore();
  const transcriptPath = path.join(dir, 'transcript.jsonl');

  const individualVideo = config.media.includes('video') && config.videoMode === 'individual';
  registry.subscribe((c) => {
    if (c.type === 'join' || c.type === 'leave' || c.type === 'rename') log.info(`participant ${c.type}`, { ...tag, userId: c.userId });
    if (individualVideo) {
      manager.handleParticipantChange(c);
      // Nobody selected yet: follow the first person whose video is on.
      if (c.type === 'video_on' && manager.state().current === null && manager.state().desired === null) manager.request(c.userId);
    }
  });

  client = createStreamClient({
    envelope: {
      product: stream.product, tenantId: stream.tenantId, meetingId: stream.meetingId, streamId: stream.streamId, serverUrls,
      generation: generation?.generation ?? stream.generation ?? 1, previousStreamId: generation?.previousStreamId ?? null,
      consentRef: stream.consentRef, policyVersion: stream.policyVersion, webhookReceivedAt: stream.startedAt
    },
    clientId: credentials.clientId, clientSecret: credentials.clientSecret, media: config.media, mediaParams: params, bufferData: config.bufferData,
    windows: config.windows, reconnect: config.reconnect, trace, log, now,
    onPhase: (phase, why) => log.info(`phase ${phase}`, { ...tag, why }),
    onEvent: ({ type, event, msg }) => {
      if (type === 'event') registry.handleEvent(event);
      if (type === 'signaling_message' && msg.msg_type === MSG.VIDEO_SUBSCRIPTION_RESP && manager) manager.handleResponse(msg);
    },
    onPacket: (p) => {
      counts[p.mediaType] += 1;
      if (p.mediaType === 'transcript') {
        const text = p.bytes.toString('utf8');
        if (config.printTranscript) log.info('transcript', { ...tag, speaker: p.userName || p.userId, text });
        const saved = transcripts.add(p);
        if (config.saveTranscript && saved.changed) {
          if (saved.revised) writeFileSync(transcriptPath, `${transcripts.lines().map((line) => JSON.stringify(line)).join('\n')}\n`);
          else appendFileSync(transcriptPath, `${JSON.stringify(saved.line)}\n`);
        }
      }
    },
    onSocketRecovered: ({ mediaType }) => { if (mediaType === 'video' && manager) manager.handleVideoSocketRecovered(); },
    manifestExtra: ({ lastStreamTs }) => ({ participants: registry.finalize(lastStreamTs) })
  });
  if (individualVideo) {
    manager = createVideoSubscriptionManager({ registry, send: (m) => client.sendSignaling(m), trace, streamId: stream.streamId, afterVideoEnds: 'next' });
  }

  const statsTimer = config.statsEverySec > 0 ? setInterval(() => {
    const s = client.snapshot();
    log.info('stats', { ...tag, phase: s.phase, packets: s.stats.packets, bytes: s.stats.bytes, byMedia: { ...counts }, duplicatesDropped: s.stats.duplicatesDropped, sockets: Object.fromEntries(Object.entries(s.sockets).map(([k, v]) => [k, v.state])) });
  }, config.statsEverySec * 1000) : null;
  statsTimer?.unref?.();

  log.info('connecting to the RTMS signaling server', { ...tag, host: safeHost(typeof serverUrls === 'string' ? serverUrls : serverUrls.signaling), media: config.media, dir });
  const done = client.start().then((result) => {
    clearInterval(statsTimer);
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
    log.info('stream finished', { ...tag, stop: result.stop.name, restart: result.stop.restart, degraded: result.manifest.degraded, packets: result.manifest.stats.packets, reconnects: result.manifest.reconnects.length, gaps: result.manifest.gaps.length, manifest: manifestPath });
    const out = { ...result, manifestPath, dir, counts: { ...counts } };
    onFinished(out);
    return out;
  });

  return { client, registry, manager, done, dir, counts };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}
