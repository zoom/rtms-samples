import WebSocket from 'ws';
import {
  backoffDelayMs, decideStop, EVENT_CODE, eventCodeOf, MEDIA_MSG_FOR_TYPE, MEDIA_TYPE, MSG, RTMS_PROTOCOL_VERSION,
  STREAM_STATE, STREAM_STATE_NAME, subscribableEventCode, TIMING
} from '../../shared/codes.js';
import { silentLogger } from '../../shared/log.js';
import { entityKeyForProduct } from '../../shared/rtmsPayload.js';
import { rtmsHandshakeSignature } from '../../shared/webhookSignature.js';
import { buildStreamManifest, chunkId, hashMediaParams } from './manifest.js';

/** Lifecycle phases from the playbook, in order. `recovering` and `degraded_or_paused` can alternate with `streaming`. */
export const PHASES = ['requested', 'webhook_received', 'signaling_connected', 'media_connected', 'client_ready_sent', 'streaming', 'degraded_or_paused', 'recovering', 'stopped', 'artifact_finalized'];

/** Defaults match the media parameters used by library/javascript/rtmsManager. */
export const DEFAULT_MEDIA_PARAMS = Object.freeze({
  audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 100 },
  video: { content_type: 3, codec: 7, data_opt: 3, resolution: 2, fps: 25 },
  deskshare: { content_type: 3, codec: 5, resolution: 2, fps: 1 },
  chat: { content_type: 5 },
  // Language id 9 is English. enable_lid lets Zoom detect other spoken languages. Same as the reference manager.
  transcript: { content_type: 5, src_language: 9, enable_lid: true }
});
const PARAM_KEY = { share: 'deskshare' };
// The signaling response names the screen share URL "sharescreen". Accept the older spellings too.
const URL_KEYS = { share: ['sharescreen', 'share', 'deskshare'] };

/**
 * RTMS protocol V2 can list several URLs for one endpoint, separated by commas
 * (for example `wss://host/ws,srt://host:port`). This client speaks WebSocket,
 * so it uses the ws/wss entry.
 */
export function pickWebSocketUrl(value) {
  if (typeof value !== 'string') return undefined;
  return value.split(',').map((url) => url.trim()).find((url) => /^wss?:\/\//.test(url));
}

/**
 * Pick the URL for one concrete media type out of the signaling response's server_urls.
 * server_urls is usually keyed by media type; V2 may return one string that serves every type.
 */
export function pickMediaUrl(serverUrls, type) {
  if (typeof serverUrls === 'string') return pickWebSocketUrl(serverUrls);
  for (const key of URL_KEYS[type] || [type]) if (serverUrls?.[key]) return pickWebSocketUrl(serverUrls[key]);
  return undefined;
}
const TYPE_FOR_MSG = Object.fromEntries(Object.entries(MEDIA_MSG_FOR_TYPE).map(([type, msg]) => [msg, type]));

/**
 * Event subscription (msg 5), as RTMS protocol V2 event codes. Without it the server sends no
 * participant, speaker or video events. Defaults match library/javascript/rtmsManager: active
 * speaker, join, leave; plus sharing and video on/off when individual video is requested; plus
 * chat group events when chat is requested.
 */
export function defaultEventSubscriptions({ media, mediaParams }) {
  const events = [EVENT_CODE.ACTIVE_SPEAKER_CHANGE, EVENT_CODE.PARTICIPANT_JOIN, EVENT_CODE.PARTICIPANT_LEAVE];
  if (media.includes('video') && mediaParams.video?.data_opt === 4) {
    events.push(EVENT_CODE.SHARING_START, EVENT_CODE.SHARING_STOP, EVENT_CODE.PARTICIPANT_VIDEO_ON, EVENT_CODE.PARTICIPANT_VIDEO_OFF);
  }
  if (media.includes('chat')) {
    events.push(
      EVENT_CODE.CHAT_GROUP_CREATE, EVENT_CODE.CHAT_GROUP_DELETE, EVENT_CODE.CHAT_GROUP_MEMBERS_ADD,
      EVENT_CODE.CHAT_GROUP_MEMBERS_DELETE, EVENT_CODE.CHAT_GROUP_MEMBER_STATUS_UPDATE
    );
  }
  return events;
}

// Handshake statuses that retrying will never fix.
const RETRYABLE_SIGNALING = new Set([8]); // duplicate signal request: the old connection has not been released yet
const RETRYABLE_MEDIA = new Set([16]); // duplicate media data connection

/**
 * One client per rtms_stream_id (one generation). It owns:
 *   - a signaling socket and one media socket per concrete media type, each with its own
 *     keep-alive watch, reconnect timer and attempt counter
 *   - the lifecycle phase, a segment list per media type, a gap list, and the final manifest
 *
 * It never reuses a finished stream. A restart means a new webhook, a new stream id and a new client.
 */
export function createStreamClient({
  envelope,
  clientId,
  clientSecret,
  media = ['audio', 'transcript'],
  mediaParams = DEFAULT_MEDIA_PARAMS,
  // false matches library/javascript/rtmsManager. true also delivers media buffered before the handshake finished.
  bufferData = false,
  trace,
  log = silentLogger,
  reconnect = {},
  windows = {},
  keepAliveSilenceLimitMs = TIMING.keepAliveSilenceLimitMs,
  keepAliveCheckMs,
  gapThresholdMs = 1500,
  terminatingGraceMs = 3000,
  dedupeCacheSize = 5000,
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  WebSocketImpl = WebSocket,
  onPacket = () => {},
  onEvent = () => {},
  onPhase = () => {},
  onSocketRecovered = () => {},
  subscribeEvents = null,
  manifestExtra = () => ({})
}) {
  const retry = { baseMs: 1000, capMs: 30_000, maxAttempts: 8, ...reconnect };
  const window = { signalingMs: TIMING.signalingReconnectWindowMs, mediaMs: TIMING.mediaReconnectWindowMs, ...windows };
  const checkMs = keepAliveCheckMs ?? Math.max(10, Math.floor(keepAliveSilenceLimitMs / 5));
  const entityKey = entityKeyForProduct(envelope.product);
  let signalingUrl = pickWebSocketUrl(typeof envelope.serverUrls === 'string' ? envelope.serverUrls : envelope.serverUrls?.signaling);

  const sockets = { signaling: newSocket('signaling', 'signaling') };
  for (const type of media) sockets[type] = newSocket(type, 'media', type);
  let mediaUrls = {};
  let phase = 'requested';
  const phases = [{ phase, at: now() }];
  let shouldReconnect = true;
  let finalized = false;
  let readySentFor = '';
  let eventsSentFor = 0;
  let result = null;
  let closeTimer = null;
  let terminatingTimer = null;
  const startedAt = { value: null };
  const stats = { packets: 0, bytes: 0, duplicatesDropped: 0, lateArrivals: 0, keepAlivesAnswered: 0 };
  const segments = [];
  const openSegments = {};
  const lastTs = {};
  const gaps = [];
  const reconnects = [];
  const pendingGap = {};
  const pendingBoundary = {};
  const firstPacketLogged = {};
  const handshakeDoneAt = {};
  const marks = { signalingReadyAt: null };
  const seen = new Set();
  const seenOrder = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function newSocket(name, kind, mediaType = null) {
    return { name, kind, mediaType, socket: null, state: 'idle', attempts: 0, disconnectedAt: null, reconnectTimer: null, watch: null, lastKeepAliveAt: 0, seq: 0, connectedOnce: false };
  }

  // --- phase ------------------------------------------------------------

  function setPhase(next, why) {
    if (finalized && next !== 'artifact_finalized') return;
    if (phase === next) return;
    phase = next;
    phases.push({ phase, at: now(), why: why || null });
    trace?.append('stream_phase', { streamId: envelope.streamId, meetingId: envelope.meetingId, tenantId: envelope.tenantId ?? null, phase, why: why || null });
    onPhase(phase, why);
  }

  const span = (name, ms, extra = {}) => trace?.append('latency_span', { streamId: envelope.streamId, meetingId: envelope.meetingId, span: name, ms, ...extra });
  const send = (sock, msg) => {
    const ws = sock.socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  // --- connect ----------------------------------------------------------

  function start() {
    if (startedAt.value !== null) return done;
    startedAt.value = now();
    setPhase('webhook_received', 'client started');
    if (!signalingUrl) {
      trace?.append('handshake_rejected', { streamId: envelope.streamId, socket: 'signaling', reason: 'no_signaling_url' });
      finalize(0, 'no_signaling_url', true);
      return done;
    }
    connect(sockets.signaling);
    return done;
  }

  function connect(sock) {
    if (finalized || !shouldReconnect) return;
    // One live or pending socket per role. A duplicate would be rejected by the server and could evict the winner.
    if (sock.socket && (sock.socket.readyState === WebSocket.OPEN || sock.socket.readyState === WebSocket.CONNECTING)) return;
    // A media handshake is only valid while signaling is up. If signaling is down, wait for it
    // instead of burning attempts that the server will reject.
    if (sock.kind === 'media' && sockets.signaling.state !== 'ready') {
      sock.state = 'waiting_for_signaling';
      return;
    }
    const url = sock.kind === 'signaling' ? signalingUrl : mediaUrlFor(sock.mediaType);
    if (!url) {
      sock.state = 'unavailable';
      trace?.append('media_unavailable', { streamId: envelope.streamId, mediaType: sock.mediaType, reason: 'no_url_in_signaling_response' });
      return;
    }
    sock.seq += 1;
    sock.state = 'connecting';
    const ws = new WebSocketImpl(url);
    sock.socket = ws;
    const connectStarted = now();

    ws.on('open', () => {
      if (sock.socket !== ws) return ws.close();
      sock.state = 'handshaking';
      sock.lastKeepAliveAt = now();
      watchKeepAlive(sock, ws);
      if (sock.kind === 'signaling') {
        pingForRtt(ws);
        send(sock, {
          msg_type: MSG.SIGNALING_HAND_SHAKE_REQ,
          protocol_version: RTMS_PROTOCOL_VERSION,
          [entityKey]: envelope.meetingId,
          rtms_stream_id: envelope.streamId,
          sequence: Math.floor(random() * 1e9),
          signature: rtmsHandshakeSignature(clientId, envelope.meetingId, envelope.streamId, clientSecret),
          buffer_data: bufferData
        });
      } else {
        const key = PARAM_KEY[sock.mediaType] || sock.mediaType;
        send(sock, {
          msg_type: MSG.DATA_HAND_SHAKE_REQ,
          protocol_version: RTMS_PROTOCOL_VERSION,
          [entityKey]: envelope.meetingId,
          rtms_stream_id: envelope.streamId,
          signature: rtmsHandshakeSignature(clientId, envelope.meetingId, envelope.streamId, clientSecret),
          media_type: MEDIA_TYPE[sock.mediaType],
          media_params: { [key]: { ...mediaParams[key] } }
        });
      }
      sock.openMs = now() - connectStarted;
    });

    ws.on('message', (raw) => {
      if (sock.socket !== ws) return; // late message from a socket we already replaced
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.msg_type === MSG.KEEP_ALIVE_REQ) {
        sock.lastKeepAliveAt = now();
        stats.keepAlivesAnswered += 1;
        send(sock, { msg_type: MSG.KEEP_ALIVE_RESP, timestamp: msg.timestamp });
        return;
      }
      if (sock.kind === 'signaling') onSignalingMessage(sock, msg);
      else onMediaMessage(sock, msg);
    });

    ws.on('close', () => onClose(sock, ws));
    ws.on('error', (error) => log.warn('socket error', { socket: sock.name, error: error.message }));
  }

  function mediaUrlFor(type) {
    return pickMediaUrl(mediaUrls, type);
  }

  /** Subscribe once per signaling connection. With individual video, wait until the video socket is live. */
  function sendEventSubscriptions() {
    if (finalized || sockets.signaling.state !== 'ready' || eventsSentFor === sockets.signaling.seq) return;
    const individualVideo = subscribeEvents === null && media.includes('video') && mediaParams.video?.data_opt === 4;
    if (individualVideo && sockets.video?.state !== 'ready') return;
    // V2 subscribes with event_code only (an entry with both fields is rejected with status 6).
    // Legacy event_type numbers passed in subscribeEvents are converted.
    const codes = [...new Set((subscribeEvents ?? defaultEventSubscriptions({ media, mediaParams }))
      .map(subscribableEventCode)
      .filter((code) => code != null))];
    if (send(sockets.signaling, { msg_type: MSG.EVENT_SUBSCRIPTION, events: codes.map((event_code) => ({ event_code, subscribe: true })) })) {
      eventsSentFor = sockets.signaling.seq;
      trace?.append('events_subscribed', { streamId: envelope.streamId, events: codes });
    }
  }

  function pingForRtt(ws) {
    const sent = now();
    ws.once('pong', () => span('signaling_ping_rtt', now() - sent));
    try { ws.ping(); } catch { /* the close handler deals with a dead socket */ }
  }

  function watchKeepAlive(sock, ws) {
    clearTimer(sock.watch);
    const tick = () => {
      if (sock.socket !== ws || finalized) return;
      if (now() - sock.lastKeepAliveAt > keepAliveSilenceLimitMs) {
        trace?.append('keepalive_silence', { streamId: envelope.streamId, socket: sock.name, silentMs: now() - sock.lastKeepAliveAt });
        ws.terminate(); // the close handler will reconnect this socket only
        return;
      }
      sock.watch = setTimer(tick, checkMs);
      sock.watch?.unref?.();
    };
    sock.watch = setTimer(tick, checkMs);
    sock.watch?.unref?.();
  }

  // --- signaling messages ---------------------------------------------------

  function onSignalingMessage(sock, msg) {
    switch (msg.msg_type) {
      case MSG.SIGNALING_HAND_SHAKE_RESP: return onSignalingHandshake(sock, msg);
      case MSG.STREAM_STATE_UPDATE: return onStreamState(msg);
      case MSG.SESSION_STATE_UPDATE:
        if (msg.state === 5) finalize(msg.stop_reason ?? msg.reason ?? 0, 'session_stopped');
        return undefined;
      case MSG.EVENT_UPDATE: return onSignalingEvent(msg.event || {});
      case MSG.STREAM_CLOSE_RESP:
        trace?.append('stream_close_response', { streamId: envelope.streamId, status: msg.status_code });
        return undefined;
      default:
        onEvent({ type: 'signaling_message', msg });
        return undefined;
    }
  }

  function onSignalingHandshake(sock, msg) {
    if (msg.status_code === 0) {
      const firstTime = !sock.connectedOnce;
      sock.connectedOnce = true;
      sock.state = 'ready';
      mediaUrls = msg.media_server?.server_urls || mediaUrls;
      recovered(sock);
      if (firstTime) {
        marks.signalingReadyAt = now();
        span('webhook_to_signaling_connected', now() - (envelope.webhookReceivedAt ?? startedAt.value));
        setPhase('signaling_connected', 'signaling handshake accepted');
      } else if (phase === 'recovering' && everyMediaReady()) setPhase('streaming', 'signaling recovered');
      for (const type of media) {
        const m = sockets[type];
        if (m.state === 'idle' || m.state === 'closed' || m.state === 'waiting_for_signaling') {
          const windowLeft = m.disconnectedAt === null ? Infinity : window.mediaMs - (now() - m.disconnectedAt);
          if (windowLeft <= 0) giveUp(m, 'window_exceeded', now() - m.disconnectedAt);
          else connect(m);
        }
      }
      sendEventSubscriptions();
      maybeSendReady();
      return;
    }
    sock.state = 'rejected';
    const duplicate = RETRYABLE_SIGNALING.has(msg.status_code) || /duplicate signal request/i.test(String(msg.reason || ''));
    if (duplicate && sock.attempts < retry.maxAttempts) {
      // Another connection for this stream is still registered. Close ours and try again after backoff.
      trace?.append('handshake_retry', { streamId: envelope.streamId, socket: 'signaling', status: msg.status_code, attempt: sock.attempts });
      sock.disconnectedAt ??= now();
      sock.socket?.close();
      return;
    }
    trace?.append('handshake_rejected', { streamId: envelope.streamId, socket: 'signaling', status: msg.status_code, reason: msg.reason ?? null });
    finalize(18, `signaling_handshake_${msg.status_code}`);
  }

  function onStreamState(msg) {
    const name = STREAM_STATE_NAME[msg.state] || `UNKNOWN_${msg.state}`;
    trace?.append('stream_state', { streamId: envelope.streamId, meetingId: envelope.meetingId, state: name, reason: msg.reason ?? null });
    switch (msg.state) {
      case STREAM_STATE.ACTIVE:
        if (['client_ready_sent', 'recovering', 'degraded_or_paused'].includes(phase)) setPhase('streaming', 'stream active');
        break;
      case STREAM_STATE.INTERRUPTED:
        setPhase('degraded_or_paused', 'stream interrupted');
        break;
      case STREAM_STATE.PAUSED:
        for (const type of media) closeSegment(type, 'paused');
        setPhase('degraded_or_paused', 'stream paused');
        break;
      case STREAM_STATE.RESUMED:
        for (const type of media) pendingBoundary[type] = 'resume';
        setPhase('streaming', 'stream resumed');
        break;
      case STREAM_STATE.TERMINATING:
        shouldReconnect = false; // the server is closing it. Do not fight it.
        // Normally TERMINATED follows. If the server just closes the sockets, do not wait for it forever.
        clearTimer(terminatingTimer);
        terminatingTimer = setTimer(() => finalize(msg.reason ?? 0, 'terminating_grace_expired'), terminatingGraceMs);
        break;
      case STREAM_STATE.TERMINATED:
        finalize(msg.reason ?? 0, 'stream_terminated');
        break;
      default:
        break;
    }
  }

  function onSignalingEvent(event) {
    const code = eventCodeOf(event);
    if (code === EVENT_CODE.MEDIA_CONNECTION_INTERRUPTED) {
      trace?.append('stream_interrupted', { streamId: envelope.streamId, meetingId: envelope.meetingId, source: 'rtms_event' });
      setPhase('degraded_or_paused', 'media connection interrupted');
    } else if (code === EVENT_CODE.FIRST_PACKET_TIMESTAMP) {
      trace?.append('first_packet_timestamp', { streamId: envelope.streamId, timestamp: event.timestamp });
    }
    onEvent({ type: 'event', event });
  }

  // --- media messages -------------------------------------------------------

  function onMediaMessage(sock, msg) {
    if (msg.msg_type === MSG.DATA_HAND_SHAKE_RESP) return onMediaHandshake(sock, msg);
    const type = TYPE_FOR_MSG[msg.msg_type];
    if (type && msg.content?.data !== undefined) onData(sock, type, msg.content);
    return undefined;
  }

  function onMediaHandshake(sock, msg) {
    if (msg.status_code === 0) {
      sock.state = 'ready';
      handshakeDoneAt[sock.mediaType] = now();
      recovered(sock);
      if (!sock.mediaSpanDone) {
        sock.mediaSpanDone = true;
        span('signaling_to_media_handshake', now() - (marks.signalingReadyAt ?? startedAt.value), { mediaType: sock.mediaType });
      }
      if (phase === 'signaling_connected') setPhase('media_connected', `${sock.mediaType} media socket handshaken`);
      else if (phase === 'recovering' && everyMediaReady() && sockets.signaling.state === 'ready') setPhase('streaming', 'all sockets ready');
      sendEventSubscriptions();
      maybeSendReady();
      return;
    }
    if (RETRYABLE_MEDIA.has(msg.status_code) && sock.attempts < retry.maxAttempts) {
      trace?.append('handshake_retry', { streamId: envelope.streamId, socket: sock.name, status: msg.status_code, attempt: sock.attempts });
      sock.disconnectedAt ??= now();
      sock.socket?.close();
      return;
    }
    sock.state = 'failed';
    trace?.append('handshake_rejected', { streamId: envelope.streamId, socket: sock.name, status: msg.status_code });
    setPhase('degraded_or_paused', `${sock.mediaType} handshake rejected`);
  }

  const everyMediaReady = () => media.every((t) => sockets[t].state === 'ready' || sockets[t].state === 'unavailable' || sockets[t].state === 'failed') && media.some((t) => sockets[t].state === 'ready');

  /**
   * CLIENT_READY_ACK goes on the signaling socket. Like the reference manager, send it after each
   * successful media handshake, so a slow or failing media socket cannot hold the others back.
   * It is sent again only when the set of live sockets changed.
   */
  function maybeSendReady() {
    if (finalized || sockets.signaling.state !== 'ready') return;
    const live = media.filter((t) => sockets[t].state === 'ready');
    if (!live.length) return;
    const signature = [sockets.signaling.seq, ...live.map((t) => `${t}:${sockets[t].seq}`)].join('|');
    if (signature === readySentFor) return;
    if (send(sockets.signaling, { msg_type: MSG.CLIENT_READY_ACK, rtms_stream_id: envelope.streamId })) {
      readySentFor = signature;
      trace?.append('client_ready_sent', { streamId: envelope.streamId, meetingId: envelope.meetingId });
      if (phase === 'media_connected' || phase === 'signaling_connected') setPhase('client_ready_sent', 'CLIENT_READY_ACK');
    }
  }

  function onData(sock, type, content) {
    // Transcript and chat arrive as text. Audio and video arrive base64 encoded.
    const bytes = type === 'transcript' || type === 'chat'
      ? Buffer.from(typeof content.data === 'string' ? content.data : JSON.stringify(content.data), 'utf8')
      : Buffer.from(String(content.data), 'base64');
    const rawTs = Number(content.timestamp);
    const hasTs = Number.isFinite(rawTs);
    const timestamp = hasTs ? rawTs : now();
    const id = chunkId({ tenantId: envelope.tenantId, meetingId: envelope.meetingId, streamId: envelope.streamId, mediaType: type, timestamp, bytes });
    if (seen.has(id)) {
      stats.duplicatesDropped += 1; // buffered media replayed after a reconnect
      return;
    }
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > dedupeCacheSize) seen.delete(seenOrder.shift());

    stats.packets += 1;
    stats.bytes += bytes.length;
    if (!firstPacketLogged[type]) {
      firstPacketLogged[type] = true;
      span('media_handshake_to_first_packet', now() - (handshakeDoneAt[type] ?? now()), { mediaType: type });
      if (['client_ready_sent', 'media_connected'].includes(phase)) setPhase('streaming', 'first packet');
    }

    const previous = lastTs[type];
    if (hasTs && previous !== undefined && timestamp < previous) stats.lateArrivals += 1; // buffered media that fills a gap
    if (hasTs && pendingGap[type] !== undefined && timestamp >= pendingGap[type]) {
      const ms = timestamp - pendingGap[type];
      if (ms > gapThresholdMs) gaps.push({ mediaType: type, fromTs: pendingGap[type], toTs: timestamp, ms, cause: 'reconnect' });
      delete pendingGap[type];
    }
    if (hasTs && (previous === undefined || timestamp > previous)) lastTs[type] = timestamp;

    let segment = openSegments[type];
    if (!segment) segment = openSegment(type, pendingBoundary[type] || (segments.some((s) => s.mediaType === type) ? 'resume' : 'start'), timestamp);
    delete pendingBoundary[type];
    segment.packets += 1;
    segment.bytes += bytes.length;
    if (hasTs) segment.lastTs = Math.max(segment.lastTs, timestamp);
    onPacket({
      mediaType: type,
      userId: content.user_id,
      userName: content.user_name,
      channelId: content.channel_id ?? null,
      sentenceId: content.sentence_id ?? null,
      attribute: content.attribute ?? null,
      source: content.source ?? null,
      language: content.language ?? null,
      startTime: content.start_time ?? null,
      endTime: content.end_time ?? null,
      timestamp,
      bytes,
      chunkId: id,
      segmentIndex: segment.index
    });
  }

  // --- segments -------------------------------------------------------------

  function paramsFor(type) {
    return { [PARAM_KEY[type] || type]: mediaParams[PARAM_KEY[type] || type] };
  }

  function openSegment(type, boundary, firstTs) {
    const segment = { mediaType: type, index: segments.filter((s) => s.mediaType === type).length, boundary, openedAt: now(), firstTs, lastTs: firstTs, packets: 0, bytes: 0, degraded: false, mediaParamsHash: hashMediaParams(paramsFor(type)), closedAt: null, closeReason: null };
    segments.push(segment);
    openSegments[type] = segment;
    return segment;
  }

  function closeSegment(type, reason) {
    const segment = openSegments[type];
    if (!segment) return;
    segment.closedAt = now();
    segment.closeReason = reason;
    delete openSegments[type];
  }

  /** If accepted media parameters change mid capture, close the segment. Never mix parameters in one decode unit. */
  function noteAcceptedParams(type, params) {
    const key = PARAM_KEY[type] || type;
    const next = hashMediaParams({ [key]: params });
    const segment = openSegments[type];
    mediaParams = { ...mediaParams, [key]: params };
    if (segment && segment.mediaParamsHash !== next) {
      closeSegment(type, 'params_changed');
      pendingBoundary[type] = 'params_changed';
      return true;
    }
    return false;
  }

  // --- close, reconnect, recovery -------------------------------------------

  function onClose(sock, ws) {
    if (sock.socket !== ws) return; // a replaced socket closing is not news
    clearTimer(sock.watch);
    sock.socket = null;
    if (finalized || !shouldReconnect) {
      sock.state = 'closed';
      return;
    }
    if (sock.state !== 'rejected') sock.state = 'closed';
    sock.disconnectedAt ??= now();
    if (sock.kind === 'media') {
      // Media that arrives after the reconnect will be reconciled against the last timestamp we saw.
      if (lastTs[sock.mediaType] !== undefined && pendingGap[sock.mediaType] === undefined) pendingGap[sock.mediaType] = lastTs[sock.mediaType];
      const open = openSegments[sock.mediaType];
      if (open) open.degraded = true;
    }
    setPhase('recovering', `${sock.name} socket closed`);
    trace?.append('socket_closed', { streamId: envelope.streamId, socket: sock.name, attempt: sock.attempts });
    // When signaling is down the media sockets close too. Reconnect signaling first: media waits for it.
    if (sock.kind === 'media' && sockets.signaling.state !== 'ready') {
      sock.state = 'waiting_for_signaling';
      trace?.append('media_waiting_for_signaling', { streamId: envelope.streamId, socket: sock.name });
      return;
    }
    scheduleReconnect(sock);
  }

  function scheduleReconnect(sock) {
    const windowMs = sock.kind === 'signaling' ? window.signalingMs : window.mediaMs;
    const downMs = now() - sock.disconnectedAt;
    if (downMs >= windowMs) return giveUp(sock, 'window_exceeded', downMs);
    if (sock.attempts >= retry.maxAttempts) return giveUp(sock, 'attempts_exhausted', downMs);
    // Never schedule an attempt that would start after the window has closed.
    const delay = Math.min(backoffDelayMs(sock.attempts, { baseMs: retry.baseMs, capMs: retry.capMs, random }), Math.max(0, windowMs - downMs - 1));
    sock.attempts += 1;
    trace?.append('reconnect_scheduled', { streamId: envelope.streamId, socket: sock.name, attempt: sock.attempts, delayMs: delay, windowRemainingMs: windowMs - downMs });
    clearTimer(sock.reconnectTimer);
    sock.reconnectTimer = setTimer(() => {
      sock.reconnectTimer = null;
      connect(sock);
    }, delay);
    return undefined;
  }

  function recovered(sock) {
    if (sock.disconnectedAt === null) {
      sock.attempts = 0;
      return;
    }
    const downMs = now() - sock.disconnectedAt;
    reconnects.push({ socket: sock.name, downMs, attempts: sock.attempts, at: new Date(now()).toISOString() });
    span('reconnect', downMs, { socket: sock.name, attempts: sock.attempts });
    trace?.append('socket_recovered', { streamId: envelope.streamId, socket: sock.name, downMs, attempts: sock.attempts });
    onSocketRecovered({ socket: sock.name, kind: sock.kind, mediaType: sock.mediaType, downMs });
    sock.disconnectedAt = null;
    sock.attempts = 0;
    if (phase === 'recovering' && Object.values(sockets).every((s) => s.disconnectedAt === null)) setPhase('streaming', 'all sockets recovered');
  }

  function giveUp(sock, why, downMs) {
    trace?.append('reconnect_failed', { streamId: envelope.streamId, socket: sock.name, why, downMs });
    // A missed window means the server has already released the stream. A new webhook and stream id are required.
    finalize(why === 'window_exceeded' ? 19 : sock.kind === 'signaling' ? 13 : 14, `reconnect_${why}`, true);
  }

  // --- stop and finalize ---------------------------------------------------------

  /**
   * Zoom sent a fresh started webhook for a stream this client already holds: an RTMS server was
   * replaced, and the same stream now has new server URLs. Drop the old sockets without counting it
   * as a failure, then reconnect signaling to the new URL. Media follows from the new signaling response.
   */
  function refresh(serverUrls) {
    if (finalized) return { applied: false, reason: 'finalized' };
    const nextSignaling = pickWebSocketUrl(typeof serverUrls === 'string' ? serverUrls : serverUrls?.signaling);
    if (!nextSignaling) return { applied: false, reason: 'no_signaling_url' };
    if (nextSignaling === signalingUrl && sockets.signaling.state === 'ready') return { applied: false, reason: 'same_server' };
    signalingUrl = nextSignaling;
    mediaUrls = {};
    for (const sock of Object.values(sockets)) {
      clearTimer(sock.reconnectTimer);
      clearTimer(sock.watch);
      sock.reconnectTimer = null;
      const ws = sock.socket;
      sock.socket = null; // detach first so this close is not mistaken for a failure
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000);
      sock.state = 'idle';
      sock.attempts = 0;
      sock.disconnectedAt = null;
    }
    readySentFor = '';
    eventsSentFor = 0;
    trace?.append('server_urls_refreshed', { streamId: envelope.streamId, meetingId: envelope.meetingId });
    setPhase('recovering', 'server replaced: new server urls');
    connect(sockets.signaling);
    return { applied: true };
  }

  /** Ask Zoom to close the stream (STREAM_CLOSE_REQ), then finalize. */
  function close(timeoutMs = 2000) {
    if (finalized) return done;
    shouldReconnect = false;
    send(sockets.signaling, { msg_type: MSG.STREAM_CLOSE_REQ, rtms_stream_id: envelope.streamId });
    closeTimer = setTimer(() => finalize(20, 'client_close'), timeoutMs);
    return done;
  }

  function finalize(stopCode, why, degraded = false) {
    if (finalized) return result;
    shouldReconnect = false;
    clearTimer(closeTimer);
    clearTimer(terminatingTimer);
    setPhase('stopped', why);
    const stop = decideStop(stopCode);
    for (const type of media) {
      closeSegment(type, 'stream_stopped');
    }
    for (const sock of Object.values(sockets)) {
      clearTimer(sock.reconnectTimer);
      clearTimer(sock.watch);
      sock.reconnectTimer = null;
      const ws = sock.socket;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        if (ws.readyState === WebSocket.CONNECTING) ws.once('open', () => ws.close(1000));
        else ws.close(1000);
      }
    }
    finalized = true;
    const wasDegraded = degraded || segments.some((s) => s.degraded) || gaps.length > 0;
    const lastStreamTs = Math.max(0, ...Object.values(lastTs));
    const manifest = buildStreamManifest({ envelope, mediaParams, segments, gaps, reconnects, stop, degraded: wasDegraded, stats, phases, extra: manifestExtra({ lastStreamTs, stop }) });
    phases.push({ phase: 'artifact_finalized', at: now(), why });
    phase = 'artifact_finalized';
    trace?.append('stream_phase', { streamId: envelope.streamId, meetingId: envelope.meetingId, tenantId: envelope.tenantId ?? null, phase, why });
    trace?.append('stream_finalized', {
      streamId: envelope.streamId, meetingId: envelope.meetingId, tenantId: envelope.tenantId ?? null, generation: envelope.generation ?? 1,
      stopCode: stop.code, stopName: stop.name, restart: stop.restart, degraded: manifest.degraded, packets: stats.packets, bytes: stats.bytes, duplicatesDropped: stats.duplicatesDropped,
      gaps: gaps.length, gapMs: gaps.reduce((sum, g) => sum + g.ms, 0), reconnects: reconnects.length, durationMs: now() - (startedAt.value ?? now()),
      consentRef: manifest.consent_ref, policyVersion: manifest.policy_version, schemaVersion: manifest.schema_version,
      artifactWriterVersion: manifest.artifact_writer_version, mediaParamsHash: manifest.media_params_hash
    });
    result = { manifest, stop };
    resolveDone(result);
    return result;
  }

  return {
    start,
    close,
    refresh,
    done,
    finalize: (code = 0, why = 'manual') => finalize(code, why),
    noteAcceptedParams,
    sendSignaling: (msg) => send(sockets.signaling, msg),
    get phase() { return phase; },
    get finalized() { return finalized; },
    snapshot: () => ({
      phase,
      sockets: Object.fromEntries(Object.entries(sockets).map(([k, s]) => [k, { state: s.state, attempts: s.attempts, down: s.disconnectedAt !== null }])),
      stats: { ...stats },
      segments: segments.map((s) => ({ ...s })),
      gaps: gaps.slice(),
      reconnects: reconnects.slice()
    })
  };
}
