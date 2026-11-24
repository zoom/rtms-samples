# 00 Backend design

Production backend design for Zoom RTMS. Read this before writing production code: it covers horizontal scaling, failover, media and codec trade-offs, observability, and webhook ingress reliability.

**Contents**

- [01 Resilient architecture](#01-resilient-architecture)
- [02 Media and codec planning](#02-media-and-codec-planning)
- [03 Observability](#03-observability)
- [04 Webhook resilience](#04-webhook-resilience)

Primary references:

- Zoom's multi-node reference: [rtms-distributed-sample](https://github.com/zoom/rtms-samples/tree/main/rtms-distributed-sample)
- [Failover and reconnection](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/)
- [Media formats and handling](https://developers.zoom.us/docs/rtms/meetings/media/)
- Single-instance reference in this guide: [50-start-and-approval](../50-start-and-approval/readme.md), [60-stream-lifecycle-client](../60-stream-lifecycle-client/readme.md), and [61-media-and-participants](../61-media-and-participants/readme.md)

## 01 Resilient architecture

A distributed RTMS backend separates the four concerns that a single-process sample keeps together.

```text
                    +---------------------+
 webhooks  -------> |  webhook ingress    |  stateless, N replicas, 200 in <3 s
                    |  (validate+enqueue) |  behind a load balancer
                    +----------+----------+
                               | queue (per-stream ordering)
                    +----------v----------+
                    |  stream workers     |  one stream = one worker at a time
                    |  signaling + media  |  leases, heartbeats, graceful handoff
                    +----------+----------+
                               |
          +--------------------+--------------------+
          |                    |                    |
   +------v-----+      +-------v------+    +--------v----------+
   | state store|      | artifact     |    | observability     |
   | leases,    |      | store        |    | metrics, traces,  |
   | dedupe,    |      | versioned,   |    | logs, stream clock|
   | seq windows|      | tenant-scoped|    |                   |
   +------------+      +--------------+    +-------------------+
```

The single-instance service in `50-start-and-approval` and `60-stream-lifecycle-client` runs the same state machine on one node. Scaling out moves state into shared storage while keeping the state transitions unchanged.

### Stream ownership

Two live connections to the same stream break capture because the second connection kicks the first. Enforce single ownership:

- One worker owns a stream at a time, enforced by a lease with a TTL and heartbeat renewal in a shared store.
- Webhook ingress never opens WebSockets. It validates the signature, records the event, and enqueues `stream_id -> event`.
- A worker claims a stream by acquiring its lease. A partitioned queue keyed by `stream_id` (or a work queue with per-stream claiming) preserves per-stream ordering for sequence numbers and dedupe keys.
- When a worker dies, its lease expires and another worker takes over from durable state. A worker that loses its lease must close its sockets immediately with no overlap period.

### The four reconnection scenarios

From Zoom's [Failover and reconnection](https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/) guide:

| # | Scenario | Trigger | Recovery |
|---|---|---|---|
| 1 | RTMS server failure | `meeting.rtms_started` arrives for an already-active stream | Close old sockets quietly and reconnect to the new `server_urls`. `meeting_uuid` and `rtms_stream_id` stay unchanged |
| 2 | Signaling dropped | `meeting.rtms_interrupted` webhook | Reconnect signaling, then media, with exponential backoff. Live observations show `rtms_interrupted` arriving ~58 s into silence and terminal `await_reconnection_timeout` (19) ~60 s later (~2 min total), but treat 60 s as your working budget |
| 3 | One media leg dropped | `MEDIA_CONNECTION_INTERRUPTED` event on signaling | Reconnect only the affected media socket while the other sockets keep running |
| 4 | Stream terminated | `meeting.rtms_stopped` with `stop_reason` 10-19 or 24 | Wait for a fresh `rtms_started` webhook. Never reconnect onto a dead stream |

**Backoff (scenarios 2 and 3).** Zoom's failover guide recommends starting at 3 s, doubling per attempt, and capping at 30 s (`60-stream-lifecycle-client` defaults to 1 s base with jitter and a 15 s live cap / 30 s client cap, tunable via `RTMS_RECONNECT_*`). Reset the attempt counter to 0 after every successful handshake so past failures do not keep delays pinned or hammer the server.

**Hard reconnect windows.** After an interruption you have roughly 60 s to restore signaling and 30 s for media (`RTMS_SIGNALING_WINDOW_SEC` and `RTMS_MEDIA_WINDOW_SEC` in `60-stream-lifecycle-client`). Once a window expires, finalize the generation and wait for a new stream.

**Idempotent handshakes.** Reconnects reuse the signed credentials from the original `rtms_started` payload. Persist that raw payload as your recovery record instead of trying to reconstruct it from REST APIs.

### Shared store contents

Minimum durable state keyed by `stream_id`:

| Data | Purpose |
|---|---|
| Raw `rtms_started` payload | Recovery record: `server_urls`, operator, timestamps |
| Lease (owner, expiry, fencing generation) | Single-writer guarantee |
| Last sequence number or timestamp per media socket | Gap and duplicate detection across reconnects |
| Dedupe keys (`event + account + meeting + stream + event_ts`) | Idempotent webhook retries and at-least-once queues |
| Stream phase (`connecting`, `streaming`, `interrupted`, `finalized`) | Health checks, alerting, safe worker handoff |
| Artifact manifest references | What was written, where, and under which retention and consent |

Raw packets and transcripts belong in the artifact store, not in worker state.

### Capacity and concurrency at scale

A concurrent stream is one RTMS session ID per media socket. The default Developer Pack limit is 2,000 sessions (5 on the free trial). `rtms.concurrency_near_limit` and `rtms.concurrency_limited` arrive per account:

- Enforce admission control at ingress so you shed noncritical starts before hitting the hard limit.
- Size workers by sockets per worker, since each media socket is a WebSocket with backpressure.
- Page on `rtms.concurrency_limited` and autoscale on `rtms.concurrency_near_limit`.

The single-instance dashboard in [70-reporting-dashboard](../70-reporting-dashboard/readme.md) plots the same panel set against live traces.

![Live dashboard with real trace](../docs/screenshots/15-dashboard-live.png)

### Failure drills

Run these drills against your real deployment before launch:

1. Kill a worker mid-stream and verify lease expiry, takeover by a second worker, zero duplicate sockets, and sequence continuity.
2. Drop signaling only (scenario 2) and verify recovery within the 60 s window and clean gap reporting.
3. Drop one media socket (scenario 3) and verify the remaining media sockets continue unaffected.
4. Re-deliver `rtms_started` with new `server_urls` for a live stream (scenario 1) and verify clean reconnection.
5. Build a queue backlog while a worker is down and verify no dropped `rtms_stopped` events and no orphaned live streams.
6. Run Zoom's [reconnection and chaos mode sample](https://github.com/zoom/rtms-samples/tree/main/rtms_api/reconnection_and_chaos_mode_js) against your service.

### Patterns to avoid

- **One connection per downstream consumer.** One worker owns the connection set; other services read artifacts or a fan-out bus.
- **Stateful ingress.** Load-balancer session affinity turns every deploy into dropped webhooks.
- **Blind timer reconnects.** Drive reconnects from webhook or socket close events with backoff. Use timers only for silence watchdogs.
- **Silent lease steals.** A fenced worker must close its sockets immediately to prevent duplicate connections.

### Trial behavior and host death

- **Trial vs paid accounts.** Free-trial accounts use the same webhooks, reconnect windows, and event semantics as paid accounts. Only the concurrency ceiling differs: 5 concurrent streams on trial versus 2,000 on a Developer Pack.
- **Host death ends the stream.** If the worker process crashes (`kill -9` or host outage), graceful close never runs. Live observations show terminal `await_reconnection_timeout` (19) firing about two minutes after silence begins, followed by a fresh `rtms_started` roughly 20 s later. Reconnect windows cover socket drops; after host death, plan for a new stream (scenario 4).
- **External node-death detection.** A WebSocket client detects a broken socket in 1-2 s (observed live: ~1.2 s signaling, ~2.1 s transcript/audio) and reconnects. Detecting a silently partitioned host requires an external heartbeat or health checker watching process liveness, socket state, and timestamp progress, with authority to fence and reassign the lease.

## 02 Media and codec planning

Media subscriptions in the data handshake set your bandwidth, CPU, storage, and muxing complexity per stream. Check Zoom's [Media handling](https://developers.zoom.us/docs/rtms/meetings/media/) page at integration time because supported formats evolve with Zoom releases.

### Media format table

| Media | Wire format | Handshake knobs | Primary cost drivers |
|---|---|---|---|
| Audio (mixed) | Raw PCM L16, 16 kHz mono, base64 in JSON | `sample_rate`, `channel`, `send_rate` (20 ms steps, 20-1000 ms) | Uncompressed storage (~115 MB/h); compress after the meeting |
| Audio (per-participant) | Same, one stream per user (merged audio is `user_id 0`) | Same, plus multi-stream option (`data_opt: 2`) | N participants multiply sockets, concurrency count, and CPU |
| Video (active speaker) | H.264 above 5 fps; JPG frames at <= 5 fps (PNG removed in V2) | Resolution (`sd` 640x360, `hd` 720p, `fhd` 1080p, `qhd` 2K), `fps` up to 30 | Resolution x fps drives bandwidth and decode CPU; server adapts downward dynamically |
| Video (single participant) | Same | Single-stream subscription (`data_opt: 4`) | One camera at a time per stream; frequent switching adds signaling load |
| Screen share | H.264 or JPG frames | Same as video | Bursty traffic (idle minutes followed by slide bursts); size buffers for bursts |
| Transcript | JSON text messages | `src_language`, `enable_lid` | Low wire cost; handle sentence revisions |

### Five choices to make explicitly

1. **Which media to subscribe to.** Each media type opens its own socket, requires its own scope, and consumes a concurrency session. Audio plus transcript covers notes, compliance, and analytics at low cost. Add video only when a feature requires frames.
2. **Merged vs per-participant audio.** Merged audio (`user_id 0`) uses one socket and covers notes and summaries; active-speaker metadata gives approximate speaker attribution. Per-participant audio gives exact diarization and per-speaker clips, at N times the socket and concurrency cost.
3. **Video resolution and frame rate.** Handshake values are ceilings, and Zoom adapts downward under load. 480p/360p at 15 fps covers archival and thumbnails, 720p is the floor for human review, and 1080p+ multiplies decode and storage cost. Use JPG frame mode (<= 5 fps) only for snapshot pipelines.
4. **Audio `send_rate`.** 20 ms (50 packets/s) gives the lowest latency for streaming ASR and live translation. Raising it to 200-500 ms cuts packet overhead for batch transcription.
5. **Transcript revisions.** When `enable_lid` is on, Zoom sends initial sentences with `attribute: 1` (NEW) and corrections with `attribute: 2` (UPDATE) carrying the same `sentence_id` and full replacement text. Appending every packet duplicates corrected sentences. The sample handles in-place replacement in [60-stream-lifecycle-client/src/transcriptStore.js](../60-stream-lifecycle-client/src/transcriptStore.js) when `RTMS_SAVE_TRANSCRIPT=true`.

### Timestamp handling and muxing

- **Use Zoom's stream clock.** Every packet carries Zoom's server-side creation `timestamp`. Join tracks on that timestamp; never re-stamp with local wall clocks.
- **Account for buffered audio.** On `rtms_started`, Zoom buffers audio (up to 60 s) while signaling connects, but does not buffer video. Compute `buffer_duration = first_packet_ts - rtms_started_ts` and subtract it when muxing to prevent A/V drift.
- **Treat silence as absence.** Muted users send no audio packets, and video stops when no camera is active. Insert silence or filler frames by timestamp arithmetic before handing files to downstream players.
- **Mux in your pipeline.** RTMS delivers separate per-media streams. Combine them with ffmpeg or gstreamer using the timestamp rules above.

### Rough per-stream capacity

Verify these numbers against your own traffic:

| Choice | Wire rate | Raw storage per hour | Decode CPU |
|---|---|---|---|
| Audio merged, 20 ms L16 | ~50 packets/s | 32 kB/s (~115 MB/h) | Low |
| Per-participant audio (N users) | xN sockets | xN | xN (still low) |
| Video 480p15 H.264 | ~300-800 kb/s | 0.15-0.4 GB/h | Moderate (1 decoder) |
| Video 720p30 H.264 | ~1-2.5 Mb/s | 0.5-1.1 GB/h | Significant per worker |
| Transcript | Negligible | A few KB | Negligible |

Re-derive worker sizing whenever you change `send_rate`, fps, or resolution.

### Subscriptions by product type

| Product | Subscribe to | Skip initially | Add later when |
|---|---|---|---|
| Meeting notes / summary | Merged audio + transcript | Video, per-participant audio | Customers ask for speaker clips |
| Compliance capture | Merged audio + transcript (+ video if policy requires frames) | Per-participant audio | Policy requires per-individual isolation |
| Live analytics dashboard | Transcript + active-speaker events | Audio, video, share | Dashboard displays video |
| Recording replacement | Audio + video + screen share (muxed) | None | None |
| Live translation | Audio (20 ms) + transcript | Video | Latency budget allows it |

Zoom Phone audio and transcript are supported in [library/javascript/rtmsManager](../../library/javascript/rtmsManager/RTMSManager.js) via `PRESETS.PHONE`. Multi-camera subscriptions (up to four concurrent 720p feeds) require server-side enablement by request.

## 03 Observability

`50-start-and-approval` writes structured decision events to `.data/events.jsonl`. Production services should keep the same event shape in their logging or analytics pipeline.

### Event log categories

Log one structured JSON line per decision and state transition, never per media packet:

- **Lifecycle:** `start_attempt` (including audit snapshot), `webhook_received` / `webhook_rejected` (with reason), `start_watchdog_fired` (with audit order), `request_status` (raw payload), `stream_phase`, `stream_finalized`, `stream_stopped` (with stop reason).
- **Media:** per-socket `socket_closed`, `socket_recovered`, `reconnect_failed` with attempt counts, sequence gaps, duplicates dropped by layer, first-packet latency, and buffered-audio offset.
- **Application:** artifact writes with schema/writer version and consent reference, tenant gate verdicts, OAuth refresh/reauthorization outcomes, and deauthorization events.

Keep logs usable during incidents:

1. Record Zoom's event timestamp beside your local receive timestamp to isolate network vs processing delay.
2. Store rejected webhooks and unknown `request_status` payloads verbatim.
3. Attach the full audit snapshot (tenant, policy, consent, gate verdict) directly to each `start_attempt` line.
4. Log IDs (`streamId`, `accountId`, `meetingId`), never tokens, secrets, or raw media.

### Page-worthy metrics

| Metric | What it signals |
|---|---|
| Start success rate (`rtms_started` / accepted starts) | Policy drift, stale OAuth, or Zoom-side blocks |
| Time to first packet (p95, p99, max) | Media-path degradation before full outages |
| Signaling reconnect success inside the 60 s window | Failed scenario 2 recoveries killing live streams |
| Per-media-leg reconnects | Isolated codec or media socket issues |
| Sequence gaps and duplicates per socket | Transport loss or broken dedupe logic |
| `rtms.concurrency_near_limit` and `rtms.concurrency_limited` | Autoscale on near-limit; page on limited |
| `start_watchdog_fired` count | Missing lifecycle webhooks |
| Webhook 5xx rate and acknowledge latency | Retries that can trigger duplicate connections |
| Reauthorization failure rate | Silent stream loss for users whose tokens decayed |
| Failed artifact writes or missing `consent_ref` | Compliance exposure and data loss |

### Alerting and tracing

- Page on user-facing symptoms (`concurrency_limited`, watchdog spikes, start success rate drops). Ticket underlying causes (near-limit warnings, reconnect churn, elevated 429s) with runbook links.
- Alert on tail latency (p95/p99) rather than averages.
- Include a direct link to the stream's log slice (`stream_id` + time window) in every alert.
- Propagate one trace ID per stream from webhook receipt through claim, handshakes, worker handoffs, artifact writes, and stop.

## 04 Webhook resilience

Zoom delivers webhooks at least once, sometimes out of order, and retries on timeouts or non-200 responses. `50-start-and-approval` implements this edge; its validated states look like this in Marketplace:

![Webhook endpoint validation green](../docs/screenshots/16-webhook-validation-green.png)

![Subscription endpoint status green in Marketplace](../docs/screenshots/17-subscription-endpoint-status.png)

### Webhook SLO

- **Return HTTP 200 within 3 seconds.** Verify `x-zm-signature` over the raw request body, enqueue the event, and return 200. Slow responses trigger retries, and a retried `rtms_started` can open a second signaling socket that kicks the first.
- **Verify every request.** Check `x-zm-signature` against raw bytes, enforce timestamp tolerance (default 300 s), and log `x-zm-request-id`. Answer `endpoint.url_validation` with `{ plainToken, encryptedToken }` using your webhook secret token.
- **Deduplicate for at least 65 minutes.** Key on `event + account + meeting/session + rtms_stream_id + event_ts` plus `x-zm-request-id`. First delivery wins; retries receive HTTP 200 and trigger no work.

### Ingress design

- Run stateless replicas behind a load balancer with no sticky sessions. Shared state lives in your database or Redis.
- Keep token refreshes, REST calls, and artifact writes out of the HTTP request handler.
- Return 200 for lifecycle events even under backpressure and let workers shed or defer work. Returning 500 adds a retry storm to an existing incident.
- Never return 200 before the event is durably enqueued. If the queue or store is down, fail loudly so Zoom retries.

### Retry and failover mechanics

- Unacknowledged webhooks retry on an approximate 5 / 20 / 60-minute backoff cadence (observed in Zoom developer forums; keep a 65-minute dedupe window). Once Zoom receives HTTP 200, it never retries that delivery.
- A fresh `rtms_started` for an active stream with a new `event_ts` and new `server_urls` is scenario 1 (server failover), not a duplicate retry. Forward it to the stream owner so the worker moves sockets to the new URLs.
- Use a watchdog to catch missed webhooks after an accepted REST start rather than polling Zoom.

### Operational checklist

1. Load-test ingress at peak concurrency multiplied by a retry storm.
2. Enforce TLS 1.2 or 1.3 end to end, monitor certificates, and complete Marketplace domain verification before going live.
3. Alert on 5xx rate, p95 acknowledge latency against the 3 s budget, dedupe store health, and queue age.
4. Run chaos tests: kill ingress replicas mid-request, partition the store, and slow the queue.
5. Rehearse `app_deauthorized` and stop-reason-8 (`stream_revoked`) purge flows.

---

## Elsewhere in the guide

Start from the [overview](../readme.md).

- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1: what changes, starter samples, gap checker
- [20 Configure](../20-configure/readme.md) - Step 2: Marketplace manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3: review package, checks, common rejections
- [40 Prepare](../40-prepare/readme.md) - Step 4: admin enablement, host approval, consent, status codes
- [50 Start and Approval](../50-start-and-approval/readme.md) - Step 5: webhook intake, claims, tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6: signaling, media, keep-alives, reconnect, manifests
- [61 Media and Participants](../61-media-and-participants/readme.md) - Step 6: participant registry, camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7: dashboard, alerts, event contract, rollout
