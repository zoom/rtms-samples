# 60 Stream lifecycle client (Step 6: stay connected)

Connects to Zoom's RTMS servers over protocol V2, runs signaling and per-media handshakes, answers keep-alives on every socket, recovers sockets independently inside Zoom's reconnect windows, tracks pause/resume boundaries, handles transcript revisions, and writes a versioned `manifest.json`. `50-start-and-approval` hands each claimed stream here, and `61-media-and-participants` adds participant tracking and camera selection on top.

**Contents**

- [Run this folder alone](#run-this-folder-alone)
- [How connection management differs from a bot](#how-connection-management-differs-from-a-bot)
- [Run against live Zoom](#run-against-live-zoom)
- [Connection sequence and lifecycle](#connection-sequence-and-lifecycle)
- [Keep-alives, reconnects, and stop reasons](#keep-alives-reconnects-and-stop-reasons)
- [Deduplication, transcript revisions, and the manifest](#deduplication-transcript-revisions-and-the-manifest)
- [RTMS protocol V2 notes](#rtms-protocol-v2-notes)
- [Test coverage](#test-coverage)
- [Adapting this sample](#adapting-this-sample)
- [Files and tests](#files-and-tests)

## Run this folder alone

```bash
npm run demo:60    # offline: local mock RTMS server, no credentials, no files
npm run test:60    # lifecycle, protocol mock, and pure-function tests
```

`demo:60` runs offline against [mockRtmsServer.js](mockRtmsServer.js) and exercises the full lifecycle: V2 handshakes, keep-alives, media delivery and replay deduplication, pause and resume boundaries, dropped-socket recovery, server URL replacement, and final manifest output.

To run the standalone demo against a live RTMS signaling URL, set `RTMS_SIGNALING_URL`, `ZOOM_CLIENT_ID`, and `ZOOM_CLIENT_SECRET` (`RTMS_MEDIA`, `RTMS_MEETING_ID`, and `RTMS_STREAM_ID` are optional). For the full webhook-to-client flow, use `npm run live` from [50-start-and-approval](../50-start-and-approval/readme.md).

## How connection management differs from a bot

| Meeting SDK bot | RTMS |
|---|---|
| SDK keeps the connection alive and reconnects | You answer every `KEEP_ALIVE_REQ` on every socket; three unanswered closes the socket |
| One connection carries all media | One signaling socket plus one media socket per media type; transcript can keep streaming while video reconnects |
| Bot stays in the meeting across brief blips | You have ~60 s to restore signaling and ~30 s for media; missing a window ends the stream and requires a new webhook and `rtms_stream_id` |
| SDK records locally through outages | Replayed buffered media arrives after reconnect and must be deduplicated; longer outages leave gaps you must record |
| Pause is a meeting-level concept | `PAUSED` and `RESUMED` are stream state updates inside the same stream |

## Run against live Zoom

```bash
cp .env.example .env    # set ZOOM_SECRET_TOKEN, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, TENANT_ACCOUNT_IDS
npm run live:check      # verifies config without printing secrets
npm run live            # listens for webhooks and connects on rtms_started
```

See [Connect to live Zoom](../50-start-and-approval/readme.md#connect-to-live-zoom) for reverse proxy and Marketplace validation steps. Each completed stream writes `manifest.json` (and optionally `transcript.jsonl`) under `.data/streams/<tenant>/<stream>/`.

To embed the client directly from a claimed `rtms_started` payload:

```js
import { createStreamClient } from './src/streamClient.js';

const client = createStreamClient({
  envelope: {
    product: 'meeting',
    tenantId,
    meetingId: payload.meeting_uuid,
    streamId: payload.rtms_stream_id,
    serverUrls: payload.server_urls
  },
  clientId,
  clientSecret,
  media: ['audio', 'transcript'],
  trace
});

const { manifest, stop } = await client.start();
```

[src/liveSession.js](src/liveSession.js) wraps this with the participant registry, single-camera video subscription manager, transcript store, manifest writer, and JSON logging.

## Connection sequence and lifecycle

```text
requested -> webhook_received -> signaling_connected -> media_connected -> client_ready_sent -> streaming
                                                                                  |  ^
                                                          degraded_or_paused <----+  +----> recovering
                                                                                  v
                                                                       stopped -> artifact_finalized
```

Every socket tracks its own state, attempt counter, keep-alive watch, and reconnect timer:

1. **Signaling handshake (`msg_type 1`):** opens the `wss://` entry from the webhook's `server_urls` and sends `protocol_version: 2`, product entity ID (`meeting_uuid`, `webinar_uuid`, `session_id`, `engagement_id`, or `call_id`), `rtms_stream_id`, a random `sequence`, `buffer_data`, and `signature = HMAC-SHA256(clientSecret, "clientId,meetingId,streamId")`. Status `8` ("duplicate signal request") retries with backoff; other failures (such as bad signatures) end the generation immediately.
2. **Media handshakes (`msg_type 3`):** reads `media_server.server_urls` (`audio`, `video`, `sharescreen`, `transcript`, `chat`) and opens one WebSocket per requested concrete media type (audio `1`, video `2`, share `4`, transcript `8`, chat `16`; the deprecated aggregate value `32` is never used). Types missing a URL are logged as `media_unavailable`.
3. **Event subscription (`msg_type 5`):** subscribes using V2 `event_code` entries only (legacy V1 numbers passed in `subscribeEvents` are mapped automatically; codes `< 1000` arrive without subscription). Default events are active speaker (`1000`), join (`1001`), and leave (`1002`), plus sharing and video on/off (`1003`-`1006`) for individual video (sent once the video socket is ready) and chat group events (`1007`-`1011`) when chat is requested. Subscriptions re-send after every signaling reconnect.
4. **`CLIENT_READY_ACK` (`msg_type 7`):** sent on signaling after each successful media handshake so a slow socket never blocks ready ones, and resent only when the active socket set changes.
5. **Streaming and pause/resume:** `PAUSED` closes open segments; `RESUMED` marks the next packet with boundary `resume` inside the same stream. `INTERRUPTED` and `MEDIA_CONNECTION_INTERRUPTED` mark the stream `degraded_or_paused` (so use `PAUSED`/`RESUMED` events specifically for user pause boundaries).
6. **Server replacement:** a fresh `rtms_started` for a stream you already hold carries replacement `server_urls`. `client.refresh(serverUrls)` closes old sockets quietly and reconnects without counting it as a failure.
7. **Stop and finalize:** `TERMINATED` or session `STOPPED` finalizes via `decideStop(reason)`. `TERMINATING` disables reconnects and arms a 3-second fallback timer in case sockets close without a final `TERMINATED` frame. `client.close()` sends `STREAM_CLOSE_REQ` (`msg_type 21`) first.

### Key settings

- **Reconnect windows:** `RTMS_SIGNALING_WINDOW_SEC` (default `60`) and `RTMS_MEDIA_WINDOW_SEC` (default `30`). Backoff starts at `RTMS_RECONNECT_BASE_MS` (`1000` ms) with full jitter, capped by `RTMS_RECONNECT_CAP_MS` (`15000` ms in live config, `30000` ms client default) and `RTMS_RECONNECT_MAX_ATTEMPTS` (`8`).
- **`RTMS_BUFFER_DATA`:** defaults to `false` (matching `library/javascript/rtmsManager`) for lower startup latency. Set `true` to request media buffered before handshake completion; chunk deduplication drops replays either way.
- **Transcript defaults:** `RTMS_TRANSCRIPT_LANGUAGE_ID=9` (English) and `RTMS_TRANSCRIPT_DETECT_LANGUAGE=true` (`enable_lid: true`).

## Keep-alives, reconnects, and stop reasons

### Keep-alives

Zoom sends `KEEP_ALIVE_REQ` (`msg_type 12`) on both signaling and media sockets; reply with `KEEP_ALIVE_RESP` (`msg_type 13`) echoing `timestamp`. Three unanswered requests cause Zoom to close the socket. If a socket sees no keep-alive for 65 seconds, the client terminates and rebuilds that socket alone. A blocked Node event loop looks identical to a dead socket.

### Reconnect matrix

| Failure | What Zoom sends | Client response |
|---|---|---|
| Zoom RTMS server replaced | Fresh `rtms_started` webhook with new `server_urls` for the same stream | Call `client.refresh(serverUrls)`: close old sockets quietly and reconnect |
| Signaling socket dropped | Interrupts signaling and media; `rtms_interrupted` lands ~58 s into silence, terminal `await_reconnection_timeout` (19) ~60 s later | Media sockets wait without burning attempts until signaling recovers; once signaling is ready, reconnect media if its window remains open |
| Single media socket dropped | `MEDIA_CONNECTION_INTERRUPTED` on live signaling | Reconnect only that media socket while others keep streaming |

Rules enforced by the client:

- Gate reconnects behind your claim lease in multi-worker deployments so two workers never fight over one `rtms_stream_id`.
- Never schedule a retry past the socket's reconnect window.
- When attempts exhaust or a window expires, finalize the generation with `degraded: true` and `requires_new_generation: true`. Wait for a new webhook and new stream ID.

### Stop reasons

Every stop is terminal for that `rtms_stream_id`. Classify the stop reason before deciding whether policy allows requesting a fresh stream:

| Reason | Meaning | Post-finalize action |
|---|---|---|
| 1 | Host stopped | Respect host stop; do not auto-restart without policy |
| 2 | App user stopped | Respect user choice |
| 3 | App user left | Apply owner-left policy |
| 4 | User ejected by host | Do not reconnect without new consent |
| 5 | Host disabled app | Wait for host to re-enable |
| 6 | Meeting ended | Finalize and close state |
| 7 | Stream canceled | Reconcile; restart only if policy allows |
| 8 | Stream revoked | Delete stored artifacts immediately, confirm purge, recheck consent |
| 9 | All apps disabled | Alert admin/host if persistent |
| 10 | Server internal exception | Retry new stream with backoff if authorized |
| 11 | Connection timed out | Follow reconnect rules |

Codes 12 through 26 (instance/signal/data interruptions, auth failure `18`, await-reconnection timeout `19`, receiver close `20`, Contact Center disconnects `21`-`22`, admin disabled `23`, keep-alive timeout `24`, manual REST stop `25`, streaming unsupported `26`) live in [shared/codes.js](../shared/codes.js). Treat policy-class reasons (`1`, `4`, `5`, `8`, `9`, `23`) as closed gates until a fresh `rtms_started` arrives; Zoom sends no "gate reopened" event.

## Deduplication, transcript revisions, and the manifest

- **Chunk deduplication:** every packet gets `chunkId = sha256(tenant + meeting + stream + mediaType + timestamp + bytes)`. Replayed buffered packets are dropped and counted.
- **Gap tracking:** on media socket close, the client records the last seen stream timestamp. When a post-reconnect chunk arrives at or after that timestamp with a delta exceeding `gapThresholdMs` (default `1500` ms), it records a gap and marks the capture degraded.
- **Parameter changes:** `noteAcceptedParams()` closes the active segment and opens a new one whenever accepted media parameters change so incompatible frames never mix in one decode unit.
- **Transcript revisions:** `streamClient.js` forwards `sentence_id`, `attribute`, and `channel_id` on every packet to `onPacket`. When `RTMS_SAVE_TRANSCRIPT=true`, [src/transcriptStore.js](src/transcriptStore.js) replaces existing sentences in place when `attribute: 2` (UPDATE) arrives rather than appending duplicates.
- **Manifest and generations:** [src/manifest.js](src/manifest.js) writes `tenant_id`, `meeting_id`, `stream_id`, `stream_generation`, `previous_stream_id`, `schema_version`, `rtms_protocol_version`, `media_params_hash`, `participant_schema_version`, `artifact_writer_version`, `policy_version`, `consent_ref`, stop reason, segments, gaps, reconnects, stats, and participant intervals. [src/generations.js](src/generations.js) numbers streams per meeting without reuse.
- **Latency spans:** writes `webhook_to_signaling_connected`, `signaling_ping_rtt`, `signaling_to_media_handshake`, `media_handshake_to_first_packet`, and `reconnect` to the trace for `70-reporting-dashboard`.

Never mutate finished artifacts. Write raw audio/video storage inside your own `onPacket` callback.

## RTMS protocol V2 notes

This client sends `protocol_version: 2` in both handshakes, opens one data socket per concrete media type, subscribes via `event_code`, and extracts the `wss://` entry from comma-separated V2 `server_urls`.

- **TLS:** TLS 1.2 or 1.3 is required on every connection.
- **Wire format and transports:** V2 adds protobuf framing (this client uses JSON), SRT data transport (`srt_passphrase`, `srt_pbkey_length`), AEAD payload encryption by request, and `REQUEST_ERROR_RESP` for failed requests.
- **Video and audio details:** SD video is 640x360, PNG is removed for video and screen share, `MEDIA_DATA_AUDIO` includes `content.source` (`1` microphone, `2` shared content), and `MEDIA_DATA_USER_INFO` arrives automatically on Meetings with `user_id`, `user_name`, and `participant_uuid`. Multi-camera (up to four concurrent 720p streams) requires server enablement by request.
- **Audio packet framing:** one frame per message for RTP and raw Opus/G711/G722; variable frames up to 128 KiB for L16.

## Test coverage

| Covered | How |
|---|---|
| Backoff inside windows, window expiry, attempt cap, `close()` before connect, missing signaling URL, V2 `event_code` mapping, `sharescreen` URL key, comma-separated URLs, chunk IDs, generations | [lifecycle.test.js](lifecycle.test.js) (10 tests, local closed port and pure functions) |
| V2 handshakes, keep-alives, media replay dedupe, pause/resume segments, full interrupt recovery, server URL replacement, keep-alive silence detection, transcript revisions | [lifecycle-mock.test.js](lifecycle-mock.test.js) (4 tests) and `npm run demo:60` against [mockRtmsServer.js](mockRtmsServer.js) |

**Validate on a live Zoom meeting before production:** exact Zoom error codes under your account policies, media waiting on signaling under real network drops, sustained-outage gap timing, and real `TERMINATING` teardown timing.

## Adapting this sample

- **Media storage:** attach your audio/video writer in `onPacket` of [src/streamClient.js](src/streamClient.js) (or [src/liveSession.js](src/liveSession.js)).
- **Reconnect and format tuning:** adjust `RTMS_SIGNALING_WINDOW_SEC`, `RTMS_MEDIA_WINDOW_SEC`, `RTMS_BUFFER_DATA`, and `RTMS_TRANSCRIPT_*` in `.env` before editing code.
- **Event subscriptions:** edit `defaultEventSubscriptions` in [src/streamClient.js](src/streamClient.js) or pass `subscribeEvents` (kept intact across signaling reconnects).
- **Custom test socket:** inject a custom `WebSocketImpl` into `createStreamClient()`.
- **Manifest schema:** add product fields in [src/manifest.js](src/manifest.js) and increment `MANIFEST_SCHEMA_VERSION`.

## Files and tests

- Source: [src/streamClient.js](src/streamClient.js), [src/liveSession.js](src/liveSession.js), [src/manifest.js](src/manifest.js), [src/generations.js](src/generations.js), [src/transcriptStore.js](src/transcriptStore.js), [mockRtmsServer.js](mockRtmsServer.js), [demo.js](demo.js).
- Tests (`npm run test:60`, 14 tests): [lifecycle.test.js](lifecycle.test.js) (10 tests), [lifecycle-mock.test.js](lifecycle-mock.test.js) (4 tests).

---

## Elsewhere in the guide

Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture, failover drills, media choices, observability, webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1: what changes, starter samples, gap checker
- [20 Configure](../20-configure/readme.md) - Step 2: Marketplace manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3: review package, checks, common rejections
- [40 Prepare](../40-prepare/readme.md) - Step 4: admin enablement, host approval, consent, status codes
- [50 Start and Approval](../50-start-and-approval/readme.md) - Step 5: webhook intake, claims, tenant gate, OAuth
- [61 Media and Participants](../61-media-and-participants/readme.md) - Step 6: participant registry, camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7: dashboard, alerts, event contract, rollout
