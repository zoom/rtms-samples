# 60 Stream lifecycle client

## Run this folder alone

```bash
npm run demo:60    # offline: local mock RTMS server, no credentials, no files
npm run test:60    # lifecycle, protocol mock and pure-function tests
```

Offline is the default. `demo:60` connects to a local WebSocket server, completes the handshakes, answers keep-alives, carries media, pauses and resumes, reconnects after a dropped socket, follows a server replacement, and prints the final manifest summary. Expect `phase client_ready_sent`, `phase streaming`, then `mock stream complete` with packets, duplicates, keep-alives, reconnects and segment boundaries. That local server, [mockRtmsServer.js](mockRtmsServer.js), is a test harness that speaks the protocol, not Zoom: the live path always connects to Zoom's real servers, and the mock exists only so reconnect, dedup and state-machine logic can be tested without a meeting.

To point the same demo at a real RTMS endpoint, set `RTMS_SIGNALING_URL`, `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET`; `RTMS_MEDIA`, `RTMS_MEETING_ID` and `RTMS_STREAM_ID` are optional. The full webhook-to-client path is in 50-start-and-approval; this folder can connect only when you already have a signaling URL.

Connects to Zoom's real RTMS servers. It runs the signaling and media handshakes, answers keep-alives, recovers each socket on its own, treats pause and resume as boundaries, and produces a versioned manifest. The start-and-approval service hands it each claimed stream, and the media-and-participants folder adds participants and cameras on top.

## Meeting SDK bot vs RTMS

| A Meeting SDK bot | RTMS |
|---|---|
| The SDK keeps the connection alive and reconnects. | You answer every keep-alive on every socket. Three unanswered and the server closes that socket. |
| One connection carries audio, video and chat. | One signaling socket plus one media socket per concrete media type. A transcript socket can stream while video recovers. |
| After a network blip the bot is still in the meeting. | You have about 60 seconds to reconnect signaling. Miss the window and the stream is gone: a new webhook and a new `rtms_stream_id` are needed. |
| The SDK records locally through an outage. | Buffered media arrives after a reconnect, and you deduplicate it. A long outage is a gap you must record. |
| Pause is a meeting concept. | Pause and resume are stream states inside the same stream. |

## Run the full service against real Zoom

```bash
cp .env.example .env              # ZOOM_SECRET_TOKEN, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, TENANT_ACCOUNT_IDS
npm run live:check                # checks your setup, prints no secrets
npm run live                      # listens for webhooks, connects to Zoom on rtms_started
```

Then start a meeting with RTMS enabled. The full walkthrough, including exposing the webhook URL, is in the "Connect to real Zoom" section of the 50-start-and-approval readme. What you see: `connecting to the RTMS signaling server`, then `phase signaling_connected`, `media_connected`, `client_ready_sent`, `streaming`, then `stats` lines with packet counts, and when the stream ends a `manifest.json` under `.data/streams/<tenant>/<stream>/`.

To drive the client yourself, build the envelope from a claimed `rtms_started` payload:

```js
import { createStreamClient } from './src/streamClient.js';
const client = createStreamClient({
  envelope: { product: 'meeting', tenantId, meetingId: payload.meeting_uuid, streamId: payload.rtms_stream_id, serverUrls: payload.server_urls },
  clientId, clientSecret, media: ['audio', 'transcript'], trace
});
const { manifest, stop } = await client.start();
```

[src/liveSession.js](src/liveSession.js) is the ready-made version: it builds the client, adds the participant registry and video subscription from 61-media-and-participants, writes the manifest and optionally the transcript, and logs one JSON line per event.

## Lifecycle

```text
requested -> webhook_received -> signaling_connected -> media_connected -> client_ready_sent -> streaming
                                                                                  |  ^
                                                          degraded_or_paused <----+  +----> recovering
                                                                                  v
                                                                       stopped -> artifact_finalized
```

Each socket has its own state, attempt counter and timers.

1. **Signaling handshake** (`msg_type 1`): protocol version, the meeting, webinar or session ID, `rtms_stream_id`, a random sequence, `buffer_data`, and the signature `HMAC-SHA256(clientSecret, "clientId,meetingId,streamId")`. The webhook's `server_urls` is the signaling URL (a string). Status 8 or a "duplicate signal request" reason retries after backoff. Anything else ends the generation: a bad signature is not retried.
2. **Media URLs** come back in `media_server.server_urls`, keyed `audio`, `video`, `sharescreen`, `transcript`, `chat`. One media socket per requested type, each with a handshake (`msg_type 3`) carrying one concrete `media_type` and its own parameters. A type with no URL is reported as unavailable. The deprecated aggregate value is never used.
3. **Event subscription** (`msg_type 5`). Without it Zoom sends no participant, speaker or video events. Default: active speaker, join, leave. With individual video it adds sharing start and stop and video on and off, and waits until the video socket is live. With chat it adds the chat group events. Sent again after every signaling reconnect.
4. **`CLIENT_READY_ACK`** (`msg_type 7`, on the signaling socket) after each successful media handshake, the way the reference manager does, so a slow media socket cannot hold the others back. Sent again only when the set of live sockets changed.
5. **Keep-alives** are answered on every socket. A socket that hears nothing for 65 seconds is closed by the client and rebuilt on its own.
6. **Reconnect** uses exponential backoff with full jitter, capped per generation (default 8 attempts) and never scheduled past the socket's window. When signaling drops, Zoom interrupts the media sockets too. So media **waits** for signaling: it spends no attempts and sends no handshake while signaling is down, then reconnects as soon as signaling is back (and gives up if its own window passed). A media socket that drops alone reconnects alone.
7. **Failed recovery or a missed window** finalizes the generation with `degraded` set and `requires_new_generation` true. It does not retry forever.
8. **Server replaced**: a new `started` webhook for a stream you already hold carries new server URLs. `client.refresh(serverUrls)` closes the old sockets quietly and reconnects to the new server. That is not counted as a failure or a reconnect.
9. `PAUSED` closes the open segments, `RESUMED` opens new ones with boundary `resume`. A pause is not a new stream. `degraded_or_paused` is not by itself proof of a user pause: a media leg can be interrupted and recover while the stream remains live, so use the `PAUSED`/`RESUMED` events for pause boundaries. `MEDIA_CONNECTION_INTERRUPTED` and `INTERRUPTED` mark the stream degraded.
10. A server stop (`TERMINATED`, session `STOPPED`) finalizes with `decideStop(reason)`. A controlled stop can move directly through `STOPPED` to `TERMINATED` without an explicit `TERMINATING`; the three-second fallback covers a server that closes the sockets after `TERMINATING`. `client.close()` sends `STREAM_CLOSE_REQ` first.

### Settings worth knowing

- **Reconnect windows.** About 60 seconds for signaling and about 30 seconds for media. The client defaults to exactly that and never retries past the window. Change them with `RTMS_SIGNALING_WINDOW_SEC` and `RTMS_MEDIA_WINDOW_SEC`.
- **`buffer_data`** defaults to false, matching Zoom's reference manager behavior. Set `RTMS_BUFFER_DATA=true` to also receive media buffered before the handshake finished. Duplicates are dropped by chunk ID either way.
- **Transcript parameters** default to English with language detection on (`src_language: 9`, `enable_lid: true`), like the reference manager.

That is the closest check available without a live stream. It is not a substitute for one: nothing in this repo has yet connected this client to a real Zoom server. Run `npm run live` with a real meeting before you rely on it.

## Deduplication, gaps and the manifest

- Every chunk gets `sha256(tenant + meeting + stream + media type + timestamp + bytes)`. Replayed buffered chunks are dropped and counted.
- A reconnect records the last timestamp before the drop. If the first new timestamp is more than `gapThresholdMs` later, a gap is recorded. Late buffered chunks that fill it are accepted and no gap is written.
- `noteAcceptedParams()` closes the current segment if the accepted media parameters change, so incompatible parameters never mix in one decode unit.
- The manifest carries `tenant_id`, `meeting_id`, `stream_id`, `stream_generation`, `previous_stream_id`, `schema_version`, `rtms_protocol_version`, `media_params_hash`, `participant_schema_version`, `artifact_writer_version`, `policy_version`, `consent_ref`, the stop reason, segments, gaps, reconnects and stats. [src/generations.js](src/generations.js) numbers the streams of one meeting and never reuses one.
- The client counts, hashes and attributes chunks. It does not store audio or video. Put your writer in `onPacket`.

## Latency spans written to the trace

`webhook_to_signaling_connected`, `signaling_ping_rtt` (a WebSocket ping to the real signaling host), `signaling_to_media_handshake`, `media_handshake_to_first_packet`, `reconnect`. The reporting dashboard turns them into p50, p95 and p99.

## What is tested, and what is not

The local protocol mock is part of the folder now. It is a test harness, not a Zoom implementation; live behavior still needs a real meeting. The automated tests:

| Covered | How |
|---|---|
| Backoff attempts inside a window, giving up when the window passes, the attempt cap, `close()` on a client that never connected, a missing signaling URL | [lifecycle.test.js](lifecycle.test.js), against a local port with nothing listening |
| Keep-alive requests and replies, media delivery and replay deduplication, pause and resume segments, recovery after both sockets drop, server replacement, silence detection | [lifecycle-mock.test.js](lifecycle-mock.test.js) and `npm run demo:60`, against [mockRtmsServer.js](mockRtmsServer.js) |
| Default event subscriptions, the screen share URL key, chunk IDs, manifest hashing, generation numbering | [lifecycle.test.js](lifecycle.test.js), pure functions |

**Not covered by the mock**, and verified only by running the full service against a real meeting: Zoom's exact status codes, media waiting for signaling under real failure timing, gap recording on a long outage, the `TERMINATING` grace period, and the phase changes driven by Zoom's messages. The client still accepts a `WebSocketImpl` option for a richer harness.

## Adapting this sample

- **Your media writer.** The client counts, hashes and attributes chunks but stores nothing. Put your storage in the `onPacket` callback of [src/streamClient.js](src/streamClient.js); the manifest and gap bookkeeping keep working whatever you write.
- **Tuning.** Reconnect windows (`RTMS_SIGNALING_WINDOW_SEC`, `RTMS_MEDIA_WINDOW_SEC`), `RTMS_BUFFER_DATA` and the transcript languages are environment settings, listed under Settings worth knowing. Start there before editing code.
- **Event subscriptions.** The default set (active speaker, join, leave) is built in `src/streamClient.js` at `msg_type 5`. Add the groups your product needs; they are re-sent after every signaling reconnect, so keep that path intact.
- **A richer test harness.** The client accepts a `WebSocketImpl` option, so you can inject your own socket implementation without touching the reconnect logic.
- **Manifest fields.** Add product-specific fields in [src/manifest.js](src/manifest.js) and bump `schema_version` when you do; [src/generations.js](src/generations.js) must keep numbering generations without reuse.

## Files

`src/streamClient.js`, `src/liveSession.js`, `src/manifest.js`, `src/generations.js`, `mockRtmsServer.js`, `demo.js`, `lifecycle.test.js` (8 tests), `lifecycle-mock.test.js` (3 tests).

---

## Step 6. Stay connected: signaling, media and recovery

With a bot the SDK kept the connection. RTMS keeps the connection alive the same way, but the machinery is yours: you answer the server's keep-alive pings, run reconnect with backoff, and deduplicate anything that arrives twice around a reconnect. The connection code is in `60-stream-lifecycle-client`, with participants and cameras in `61-media-and-participants`.

### The connection, in order

```text
1. Open the signaling WebSocket (the webhook's server_urls). Send the signaling handshake.
     fields: protocol version, the meeting / webinar / session ID, rtms_stream_id, a sequence, buffer_data,
             signature = HMAC-SHA256(clientSecret, "clientId,meetingId,streamId")
2. The response lists a URL per media type: audio, video, sharescreen, transcript, chat.
3. Open one media WebSocket per requested type. Send a media handshake carrying ONE concrete media type
     and that type's parameters. (The old aggregate "all media" value is deprecated.)
4. Subscribe to events on the signaling socket. Without this Zoom sends no participant,
     speaker or video events.
5. Send CLIENT_READY_ACK on the signaling socket after each successful media handshake.
6. Receive. Answer every KEEP_ALIVE_REQ with the same timestamp, on EVERY socket.
```

Concrete media types are audio 1, video 2, screen share 4, transcript 8, chat 16. Why split sockets? Each type gets its own scope and parameter check, can back off on its own, reconnect on its own, and change codec on its own, so a slow consumer on one type cannot block the rest.

### Keep-alives

Both sockets get keep-alive requests. Three unanswered requests and the server closes that socket, which stops zombie writers and duplicate consumers. If you hear nothing for about 65 seconds, treat the socket as dead and rebuild it. A blocked event loop looks exactly like a dead socket, so keep the loop healthy.

### Reconnect, or what Zoom does in each failure

| What breaks | What Zoom does | What you do |
|---|---|---|
| A Zoom RTMS server fails | A replacement starts and Zoom sends a **new** `rtms_started` webhook with fresh `server_urls` for the same stream | Move the stream to the new URLs. Close the old sockets quietly. Do not open a second stream |
| Your signaling socket drops | Zoom interrupts signaling **and** media, and sends `rtms_interrupted`. It waits about 60 seconds | Reconnect signaling first, then media |
| Only a media socket drops | Zoom sends the `MEDIA_CONNECTION_INTERRUPTED` event on the live signaling socket | Reconnect only that media socket |

Rules that follow:

- Reconnect each socket on its own. Never assume they fail or recover together, and a transcript socket can stream while video recovers.
- A media handshake only works while signaling is up. So media waits for signaling, spends no attempts meanwhile, and reconnects as soon as signaling is back.
- Do not blindly resend a successful media handshake. Look at the socket and the stream state first.
- If Zoom rejects a signaling handshake as a duplicate (another connection for this stream is still registered), close yours and retry after backoff. Keep one winner. The client does this.
- One connection per stream ID, ever. A second connection kicks the first off, not the other way around. Two claimants whose retry logic fires blind will kick each other forever, so gate every reconnect behind the claim fence: the lease owner reconnects, the loser waits and only retries once it has won the lease. Never let a raw socket failure alone authorize a reconnect.
- Use exponential backoff with jitter, cap the attempts per stream, and never schedule an attempt past the window.
- If recovery fails or the window passes, finalize that stream and mark it degraded. A restart needs a new webhook and a **new stream**. Never reuse old signaling state.

**The windows.** After a disconnect you have 60 seconds to get signaling back and about 30 seconds to get media back. The client defaults to exactly that and never retries past the window. Change them with `RTMS_SIGNALING_WINDOW_SEC` and `RTMS_MEDIA_WINDOW_SEC`. Backoff starts at 1 second here and is capped by `RTMS_RECONNECT_CAP_MS`.

### Pause, resume, stop and restart

A stream can be **paused and resumed without becoming a new stream**. Track the `STREAM_STATE_UPDATE` states `PAUSED` and `RESUMED`, not only active and stopped. Treat the last packet before `PAUSED` and the first after `RESUMED` as segment boundaries. The client follows these messages and does not query the state itself, so if your own state is uncertain after a resume, query the stream state before you continue. A **stop is terminal** for that stream: persist artifacts, map the reason to an action, and if your policy allows a restart wait for a new started webhook with a new stream ID.

The same meeting can have several streams over its life, one generation each. Key your state by tenant, product, meeting and `rtms_stream_id`, number the generations, link each to the previous one, and never overwrite one. Make duplicate stops harmless.

| Reason | Meaning | After you finalize |
|---|---|---|
| 1 | Host stopped | Do not restart without policy |
| 2 | App user stopped | Respect their choice |
| 3 | App user left | Apply your owner-left policy |
| 4 | User ejected by host | Do not reconnect without consent |
| 5 | Host disabled the app | Wait for the host to re-enable it |
| 6 | Meeting ended | Finalize and close state |
| 7 | Stream canceled | Reconcile. Restart only if policy allows |
| 8 | Stream revoked | **Delete assets immediately** and confirm. Recheck authorization and consent |
| 9 | All apps disabled | Alert the admin or host if it persists |
| 10 | Server internal exception | Retry with backoff if authorized |
| 11 | Connection timed out | Reconnect by the rules above |

Codes 12 to 26 (instance, signal and data interruptions, authentication failure, await-reconnection timeout, keep-alive timeout, admin disabled, and others) are in `shared/codes.js` with an action each. Their restart column is a reading of the reference library's lookup table, not Zoom policy, so check it against your own rules.

The decision rule behind both tables: classify the stop reason before you retry. Network-class reasons (10, 11, and the 12 to 26 connection failures) justify an automatic retry under the reconnect rules above. Policy-class reasons (1, 4, 5, 8, 9) mean a human or admin gate is closed, so no retry until it clears. Zoom sends no "gate is open again" event: the first sign of recovery is a fresh `rtms_started`, so treat any silent no-prompt-no-webhook stretch after a policy stop as the gate still being shut, not as a lost request.

### Missed audio, buffering and duplicates

**Can I recover audio missed at startup or during an interruption?** Yes, with a tradeoff. `buffer_data: true` in the signaling handshake delivers media buffered before the handshake finished, which you may see twice. `false` favors startup latency and avoiding duplicates. The reference library sends false, and so does this client by default (`RTMS_BUFFER_DATA`). After a reconnect, buffered media arrives once the new connection is up: deduplicate it by stream, timestamp and content. Buffering does not cover an arbitrarily long outage, so compare timestamps, record the gap, and mark that segment degraded.


### The artifact record and its versions

Every stream and artifact carries these fields, so you can replay, remux or migrate later without guessing what produced it.

| Field | Meaning |
|---|---|
| `schema_version` | Your event and manifest shape |
| `rtms_protocol_version` | The version sent in the signaling handshake |
| `stream_generation`, `previous_stream_id` | Which stream of the meeting this is |
| `media_params_hash` | Hash of the accepted media parameters. If it changes inside a capture, close the segment and open a new one |
| `participant_schema_version` | Your participant model version |
| `artifact_writer_version` | Your encoder and storage writer version |
| `policy_version`, `consent_ref` | The policy snapshot and consent record in force |

Never mutate an original artifact. Keep writing the old version until a tested writer is enabled. The client writes these into `manifest.json`, plus segments, gaps, reconnects, stop reason and participant intervals. It does not store audio or video: put your writer in `onPacket`.

### What is verified, and what is not

| Verified | How |
|---|---|
| Backoff and giving up when a server is unreachable, the attempt cap, closing a client that never connected, subscription defaults, chunk IDs, generations | Unit tests, with nothing listening on the port |
| Participant registry, one-camera subscription logic, media parameters | Unit tests |
| Meeting-level policy for two users, the capture filter, per-user tokens with refresh and reauthorization, verified deauthorization, REST pause and resume | Unit tests, plus a run of the real server against its HTTP routes (nothing connected to Zoom) |
| An established connection: handshakes, keep-alives, media delivery, replay deduplication, `PAUSED`/`RESUMED` segment boundaries, reconnect and recovery, replacement server URLs, scripted terminal states, and manifest counters | [60-stream-lifecycle-client](60-stream-lifecycle-client/readme.md): `lifecycle-mock.test.js` and `npm run demo:60`, against the repository's mock RTMS server |
| Silence detection and recovery without hard-coded waits | The same lifecycle mock tests |

### November release preview (not yet live)

Plan for these; none change the V1 client today. TLS 1.2 or 1.3 becomes required on every connection from 15 November 2026, so pin your Node TLS range now. The V2 protocol adds a protobuf wire format (JSON stays unchanged and works on both), `event_code` replacing the legacy `event_type`, an SRT transport option for data connections (`srt_passphrase` and `srt_pbkey_length` in the handshake response), AEAD payload encryption by request only, a `REQUEST_ERROR_RESP` message with `status_code` and `reason` for failed requests, and multiple individual video streams (up to four concurrent 720p subscriptions per stream, server feature by request). SD video becomes 640x360 and PNG goes away for video and screen share. Transcript rewind sends UPDATE events with the same `sentence_id` and full replacement text whenever `enable_lid` is on: replace the sentence, do not append. `MEDIA_DATA_USER_INFO` arrives unsubscriptioned on the event channel with `user_id`, `user_name` and `participant_uuid` (Meetings only), and `MEDIA_DATA_AUDIO` gains `content.source` (1 microphone, 2 shared content). Audio boundaries change: one frame per message for RTP and raw Opus/G711/G722, variable frames up to 128 KiB for L16.

The mock is a protocol harness, not Zoom. Before production, validate the remaining real-service behavior: Zoom's exact status codes and phase timing, media waiting for signaling under real failure timing, sustained-outage timing, and the real `TERMINATING` grace period. The F3 coverage sample demonstrates the gap, state and representative-code logic against the mock; it is not a substitute for a live meeting.

---
