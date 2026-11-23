import { WebSocketServer } from 'ws';
import { MEDIA_MSG_FOR_TYPE, MSG } from '../shared/codes.js';

const listen = (servers, options) => new Promise((resolve, reject) => {
  const wss = new WebSocketServer(options);
  wss.once('error', reject);
  wss.once('listening', () => resolve(wss));
  servers.push(wss);
});

const closeServer = (wss) => new Promise((resolve) => wss.close(() => resolve()));

/**
 * A scripted RTMS peer for the lifecycle client: the same WebSocket messages, on real localhost
 * sockets. It is a test harness, not a Zoom implementation. It serves one client at a time.
 */
export async function createMockRtmsServer({ host = '127.0.0.1', keepAliveMs = 0 } = {}) {
  const servers = [];
  const sockets = new Set();
  const timers = new Set();
  const messages = [];
  let current = await listenOn();

  async function listenOn() {
    const wss = await listen(servers, { host, port: 0 });
    const mediaUrls = mediaUrlsFor(wss);
    const url = `ws://${host}:${wss.address().port}/signaling`;

    wss.on('connection', (ws) => {
      ws.role = 'pending';
      sockets.add(ws);
      ws.on('close', () => {
        clear(ws.keepAliveTimer);
        sockets.delete(ws);
      });
      ws.on('error', () => ws.close());
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        messages.push({ role: ws.role, mediaType: ws.mediaType ?? null, msg });
        if (msg.msg_type === MSG.SIGNALING_HAND_SHAKE_REQ) {
          ws.role = 'signaling';
          // RTMS protocol V2 can list an SRT URL next to the WebSocket URL.
          const v2MediaUrls = Object.fromEntries(Object.entries(mediaUrls).map(([type, url]) => [type, `srt://${host}:9000,${url}`]));
          sendTo(ws, { msg_type: MSG.SIGNALING_HAND_SHAKE_RESP, protocol_version: msg.protocol_version, status_code: 0, media_server: { server_urls: v2MediaUrls } });
        } else if (msg.msg_type === MSG.DATA_HAND_SHAKE_REQ) {
          ws.role = 'media';
          ws.mediaType = Number.isFinite(msg.media_type) ? msg.media_type : null;
          sendTo(ws, { msg_type: MSG.DATA_HAND_SHAKE_RESP, status_code: 0, media_type: msg.media_type });
        } else if (msg.msg_type === MSG.STREAM_CLOSE_REQ) {
          sendTo(ws, { msg_type: MSG.STREAM_CLOSE_RESP, status_code: 0 });
        } else if (msg.msg_type === MSG.VIDEO_SUBSCRIPTION_REQ) {
          sendTo(ws, {
            msg_type: MSG.VIDEO_SUBSCRIPTION_RESP,
            status_code: 0,
            user_id: msg.user_id,
            subscribe: msg.subscribe
          });
        }
      });
      if (keepAliveMs > 0) {
        ws.keepAliveTimer = setInterval(() => keepAlive(ws), keepAliveMs);
        timers.add(ws.keepAliveTimer);
      }
    });

    return { wss, url, mediaUrls };
  }

  function mediaUrlsFor(wss) {
    const { port } = wss.address();
    const types = ['audio', 'video', 'share', 'transcript', 'chat'];
    return Object.fromEntries(types.map((type) => [type, `ws://${host}:${port}/media/${type}`]));
  }

  const clear = (timer) => {
    if (!timer) return;
    clearInterval(timer);
    timers.delete(timer);
  };

  const open = (role = null, mediaType = null) => [...sockets].filter((ws) =>
    ws.readyState === ws.OPEN && (!role || ws.role === role) && (mediaType === null || ws.mediaType === mediaType));
  const sendTo = (ws, msg) => ws.send(JSON.stringify(msg));

  function send(msg, { role, mediaType } = {}) {
    const targets = open(role, mediaType);
    for (const ws of targets) sendTo(ws, msg);
    return targets.length;
  }

  function keepAlive(ws = null, timestamp = Date.now()) {
    if (ws) return sendTo(ws, { msg_type: MSG.KEEP_ALIVE_REQ, timestamp });
    return send({ msg_type: MSG.KEEP_ALIVE_REQ, timestamp }, { role: 'signaling' })
      + send({ msg_type: MSG.KEEP_ALIVE_REQ, timestamp }, { role: 'media' });
  }

  function media(type, content) {
    const numeric = { audio: 1, video: 2, share: 4, transcript: 8, chat: 16 }[type];
    return send({ msg_type: MEDIA_MSG_FOR_TYPE[type], content }, { role: 'media', mediaType: numeric });
  }

  const event = (event) => send({ msg_type: MSG.EVENT_UPDATE, event }, { role: 'signaling' });

  const streamState = (state, reason = null) => send({ msg_type: MSG.STREAM_STATE_UPDATE, state, reason });
  const closeSockets = (role = null) => { for (const ws of open(role)) ws.close(1000); };

  /** Close signaling first, then media: the client must rebuild signaling before media returns. */
  function interrupt() {
    closeSockets('signaling');
    closeSockets('media');
  }

  async function replaceServer() {
    current = await listenOn();
    return { serverUrls: { signaling: current.url, ...current.mediaUrls } };
  }

  async function close() {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    for (const ws of sockets) {
      clear(ws.keepAliveTimer);
      ws.close(1000);
    }
    await Promise.all(servers.map(closeServer));
    sockets.clear();
  }

  return {
    get urls() { return { signaling: current.url, ...current.mediaUrls }; },
    keepAlive,
    media,
    event,
    messages: () => [...messages],
    streamState,
    interrupt,
    replaceServer,
    close,
    socketCount: () => sockets.size
  };
}
