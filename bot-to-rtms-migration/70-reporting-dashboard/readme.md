# 70 Reporting dashboard

Turns the event trace into the numbers a migration needs after go-live: is the start funnel healthy, how fast is the first packet, how often do sockets recover, why do streams stop, how close are you to the concurrency limit, and is every artifact tied to a consent reference.

**Contents**

- [Run this folder alone](#run-this-folder-alone) and [run it](#run-it) - the commands
- [The panels](#panels) and [the `crm_sync` event](#the-crm_sync-event) - what each panel shows, and the event your pipeline appends
- [Sample data](#sample-data), [production](#production), [Adapting this sample](#adapting-this-sample) and [files and tests](#files-and-tests)
- [Step 7. Operate it](#step-7-operate-it) - the guide chapter: seeing what happens, tenant isolation, the production checklist, what to swap, rollout, cost and concurrency, Zoom support, the November changes, the go-live gate

## Run this folder alone

```bash
npm run demo:70 -- --json    # offline: deterministic sample trace, no environment
npm run start:70 -- --sample # serve the sample at http://127.0.0.1:4806/
```

No environment is required. The demo writes nothing by default and prints the report summary as JSON. `npm run demo:70` alone writes `.data/report.html` and prints a human-readable summary. The sample server serves the same data at `/`. For your own trace, omit `--sample` and set `TRACE_FILE` or use the CLI `--trace` option shown below.

## Meeting SDK bot vs RTMS

| A Meeting SDK bot | RTMS |
|---|---|
| One number mattered: did the bot join. | Four hops matter and fail separately: Zoom to webhook, webhook to signaling, handshake to first packet, packet to your result. |
| Averages were fine. | Alert on p95 and p99. A mean hides the slow starts. |
| Capacity was your own compute. | Concurrency is an entitlement. You must see peak against the limit before `rtms.concurrency_limited` blocks new streams. |
| Usage meant bot minutes. | Meter per tenant and per stream. Multiple media sockets raise the operational stream count. |
| Retention was a storage decision. | An artifact needs a consent reference and version fields to be defensible later. |

## Panels

| Panel | Source events |
|---|---|
| Start funnel (claimed, signaling, media, ready, streaming, finalized) and start requests | `stream_claimed`, `stream_phase`, `start_attempt`, `request_status`, `start_watchdog_fired` |
| Latency p50, p95, p99 per span, and first packet per media | `latency_span` |
| Concurrency over time against the limit | stream intervals, `concurrency` |
| Reconnects, pauses, gaps | `socket_closed`, `socket_recovered`, `reconnect_failed`, `keepalive_silence`, `stream_state`, `stream_finalized` |
| Stop reasons (one per stream) | `stream_stopped`, `stream_finalized` |
| Duplicates dropped, by layer | `webhook_duplicate`, `duplicate_stream_dropped`, `late_duplicate_dropped`, `stream_refresh`, `stream_finalized` |
| Usage per tenant | `stream_finalized` |
| Artifacts: version, generation, consent reference | `stream_finalized` |
| Webhook intake: rejected, refused by the tenant gate | `webhook_rejected`, `stream_refused` |
| CRM sync status | `crm_sync` |
| Alerts | revoked stream, missing consent reference, limit reached, lost claim, missing started webhook |

### The `crm_sync` event

The CRM step belongs to your pipeline, so it writes its own events. Append one per status change:

```json
{ "v": 1, "type": "crm_sync", "streamId": "rtms-1004", "tenantId": "acme", "status": "pending" }
{ "v": 1, "type": "crm_sync", "streamId": "rtms-1004", "tenantId": "acme", "status": "failed", "attempts": 3 }
```

The latest status per stream wins. Finalized artifacts with no `crm_sync` event show as "not queued".

## Run it

```bash
npm run demo:70                       # seeded sample data, writes .data/report.html and prints a summary
npm run start:70 -- --sample          # serve the sample at http://127.0.0.1:4806/
npm run start:70                      # serve your own trace (TRACE_FILE, default .data/events.jsonl)
node 70-reporting-dashboard/cli.js --trace .data/events.jsonl --hours 24 --out report.html
node 70-reporting-dashboard/cli.js --sample --json
```

`npm run live` (and `npm run demo:03 -- --write-trace`) append to the same trace, so the page shows your own real streams. The page is one static HTML file: no scripts, no external assets. Every value from the trace is escaped. `GET /api/report` returns the same data as JSON.

With a verified live run behind it, the dashboard shows the real streams and their phases, latency panels filled, and the stop reasons your meetings actually produced:

![Dashboard serving the real trace: both streams, latency panels, stop reasons](../docs/screenshots/15-dashboard-live.png)

## Sample data

[sample-data/generate.js](sample-data/generate.js) produces a deterministic trace shaped exactly like the real samples write it: 24 streams, 3 tenants, reconnects, pauses, duplicates, rejected webhooks, a watchdog firing, a concurrency limit reached, CRM statuses, and one artifact without a consent reference so the audit alert has something to show. A small committed file, [sample-data/events.sample.jsonl](sample-data/events.sample.jsonl), shows the format. A test fails if it drifts from the generator.

## Production

The report builder is a pure function over events. In production compute the same panels from your own logging or analytics store, and alert from there. Keep the event names and fields: they are the contract between the samples. Percentiles use nearest rank.

## Adapting this sample

- **New panels.** Compute them in [src/report.js](src/report.js) from the event stream and render them in [src/render.js](src/render.js). The report is a pure function over events, so a new panel is a new reduction, plus one test.
- **Your alerts.** Thresholds for the critical alerts (revoked stream, missing consent, limit reached, lost claim) are in the report builder. Move alerting into your pager by consuming `GET /api/report` or the same events.
- **Your CRM.** Emit `crm_sync` events from your pipeline as documented above. The panel needs nothing else. Add statuses freely, the latest per stream wins.
- **The event contract.** Keep the event names and fields. They are the contract between steps 5, 6 and 7, and a test feeds the stream client's events through the report to enforce it.

## Files and tests

`cli.js`, `server.js`, `src/report.js`, `src/render.js`, `sample-data/`, `report.test.js` (9 tests, including one that feeds the stream client.s event names through the report).

---

## Step 7. Operate it

### See what is happening

```bash
npm run demo:70            # a dashboard from seeded sample data: .data/report.html
npm run start:70           # your own streams: http://127.0.0.1:4806/
```

The dashboard is one static page: start funnel, first-packet latency at p50, p95 and p99, concurrency against your limit, reconnects, pauses and gaps, stop reasons, duplicates dropped by layer, usage per tenant, artifacts with their versions and consent reference, CRM sync status, and alerts. Run it on a trace file written by `npm run live`, with `--sample` for seeded data. The real streams write their events to `.data/events.jsonl`. In production compute the same panels from your own logging, keeping the event names.

Alert on: p95 and p99 first-packet latency, reconnect failures, started webhooks that never arrived, `rtms.request_status` failures, concurrency near the limit, any artifact with no consent reference, and any revoked stream. For CRM sync, your pipeline writes `crm_sync` events with a `status` and the dashboard shows the latest per stream, plus finalized artifacts that never reached the CRM.

### Multi-tenant isolation

A bot ran under one service account. RTMS is policy heavy, so store per tenant: the app installation and user, the admin policy snapshot, the approved host domains or meeting IDs you need for audit, the consent references, and the stream and media mappings with a retention class. Gate every stream and every artifact write on "does this account have a tenant that permits this product and media, with a consent reference". Keep tenant-scoped storage paths and refuse path traversal.

### Production checklist

| # | Check | In this folder | You still own |
|---|---|---|---|
| 1 | Verify, persist and queue webhooks before side effects | Signature on the raw body, 300 s tolerance, 200 first | Durable raw-body storage and a queue between endpoint and workers |
| 2 | Event, connection and artifact idempotency | The three dedupe layers, with fencing | A shared claim store for more than one process |
| 3 | Answer keep-alives on every socket | The client, with a silence watchdog | Event-loop health under load |
| 4 | Reconnect independently with bounded backoff and jitter | Per-socket attempts, jitter, windows, attempt cap | Tuning on your network, consumer backpressure |
| 5 | Preserve recovery markers, pause boundaries and gaps | Segments, gaps, `degraded`, the manifest | Writing them into your artifact format |
| 6 | Normalize joins, renames, duplicate names, roles | The participant registry | A source for roles, identity resolution |
| 7 | Isolate tenants, credentials, policy and retention | The tenant gate, tenant paths, audit snapshot | Per-tenant credentials, retention jobs, deletion on revoke |
| 8 | Log IDs and state, never secrets or raw media | Trace events carry IDs and state names only | Redaction and access control in your logging |
| 9 | Test host absence, denial, cohost change, waiting room, lock, webinar, pause, resume, revoke | Request status handling and revoke | Live tests on real accounts: cohost change, waiting room, lock and webinar are not simulated |
| 10 | Load test concurrent streams and per-socket recovery | Not covered | A load test against real Zoom with your entitlement, killing sockets on purpose |
| 11 | Negotiate TLS 1.2 or 1.3 (required from 2026-11-15) | `ws` on a current Node release does by default | Your proxy and runtime settings |
| 12 | Per-user tokens, reauthorization and deauthorization | `src/oauth.js`: refresh, rotation, reauthorization flag, verified deauthorization | A secret store for tokens, deleting the rest of a user's data, a reauthorization campaign |
| 13 | Count concurrency per media socket, and plan for spiky starts at the top of the hour | A concurrency event handler that sheds and blocks | A queue and autoscaling workers, and a load test |

### What to swap before production

| In the samples | In production |
|---|---|
| In-memory dedupe set and claim registry, per process | One shared store: an atomic unique-key insert in your database, or Redis `SET key owner NX PX leaseMs`. Keep the claim, renew and release contract and the generation as a fencing token |
| A JSON-lines trace file (not a database; nothing here uses one) | Your logging or analytics pipeline. Keep the event names |
| `tenants.sample.json` or `TENANT_ACCOUNT_IDS` | Your install, policy and consent records |
| The file token store (`OAUTH_TOKEN_DIR`) | Your secret store or an encrypted column, with the same get, set, delete and list contract |
| Work runs after the 200, in the same process | Put the verified event on a queue, return 200 first, and have a worker run the client |
| The `onPacket` hook | Your artifact writer: durable, versioned, tenant-scoped |
| The static HTML dashboard | Your metrics and alerting stack |

### Roll out to your customers

Moving users and organizations takes longer than changing code. A pattern that works (a recommendation, not a Zoom process):

1. **Build and review.** A separate user-managed RTMS app, submitted early.
2. **Dogfood.** Your own account plus one external test tenant.
3. **Design partners.** Three to five customers, admin-assisted setup, RTMS and the bot side by side behind a per-tenant flag.
4. **Cohorts.** Reauthorization campaign, an admin outreach kit, one flag per tenant.
5. **Default to RTMS.** The bot becomes the exception, with a deadline.
6. **Decommission** the bot fleet.

While both run, decide which one captures a given meeting. Never let both capture the same meeting, unless the bot is an explicit fallback that starts only when RTMS produced no stream by a deadline you choose.

Measure the start success rate (started webhooks against the meetings you expected), the time to first packet, the share of meetings captured against the bot baseline, the approval prompt rate, the denial rate, reauthorization completion, and the cost per captured hour.

### What it costs, and how concurrency is counted

1. RTMS needs Zoom Developer Pack credits. Volume discounts and commitments above 500 credits go through sales. Basic accounts are not supported: webhooks do not fire and API calls fail with `2310`.
2. The default limit is **2,000** concurrent streams on a Developer Pack (5 on the free trial), and higher limits are available by request.
3. A concurrent stream is one RTMS **session ID**, not one meeting. A new one is created when you start RTMS in a new meeting, and again when you open a socket for a different media type in the same meeting. Audio and video on separate sockets in one meeting count as **two**. Plan capacity as the sum over live meetings of the media types you open.
4. `rtms.concurrency_near_limit` arrives periodically above 80 percent of the limit, and `rtms.concurrency_limited` when the limit is reached. Request status `5` means no limit is set on the account.
5. Check concurrency on every account and subaccount after purchase. Partners found limits that were never configured on subaccounts. The docs say to contact your account executive for limits and do not name an approval authority, so ask before launch, not when the limit event arrives.
6. REST start: Zoom's RTMS guide calls it a light API with a limit of 80 requests per second per account, shared by every light API on the account. The API reference lists a MEDIUM rate limit label, so check Zoom's rate limits page for the number that applies to you, and retry `429` with jitter.

To compare with running bots, multiply meetings per day by average minutes, by the media types you open, by a duplicate factor (the share of meetings that more than one of your users start), then add your own transfer, decoding, storage and AI costs. Levers: open only the media you use, prefer Zoom's transcript to audio plus your own speech recognition when it is good enough, decide a meeting-level rule so two users do not create two streams, and use the capture filter for rules auto-start cannot express. Per-participant audio or several individual cameras multiply streams.

### When you contact Zoom support

Collect before you open a case: your client ID and the account ID. The meeting UUID and ID, the `rtms_stream_id` and the `operator_id`. UTC times and the raw payloads of `rtms_started`, `rtms.request_status` and `rtms_stopped`. The start path and any REST error code (`2308`, `2310`, `13262`, `13267`, `13273`). And the user's auto-start settings and the host's Always ask or Always allow at that moment. Zoom's published routes are the Developer Forum and Premier Developer Support. Zoom staff can look a meeting up in internal tooling, which is not documented as self-serve, so send the identifiers.

### What changes in the November release (preview, not shipped)

From Zoom's release preview. Plan for it, but do not promise it to customers:

1. **V2 protocol:** protobuf wire format (JSON messages keep working), SRT as a data transport next to WSS, `event_code` in place of `event_type`, standard definition video becoming 640x360 and PNG no longer available for video or screen share. The handshake `protocol_version` defaults to `1`. Zoom does not document a pinning or advance-notice policy.
2. **Transcript rewind.** Corrections to sentences already delivered. The first delivery is a NEW event (`attribute: 1`), and revisions are UPDATE events (`attribute: 2`) with the same `sentence_id` and the full replacement text. Replace the sentence, do not append. The sample writer now does this when `RTMS_SAVE_TRANSCRIPT=true`. Verify it with the F3 coverage test.
3. **`REQUEST_ERROR_RESP`, `MEDIA_DATA_USER_INFO`, an audio `source` field**, application-layer AEAD media encryption (approved per app, by request), and **Zoom Phone** audio and transcript.
4. **TLS 1.2 or 1.3 required on every connection from 2026-11-15.** The `ws` client on a current Node release negotiates TLS 1.2 or newer by default. Check your own proxy or runtime if you changed it.

Zoom documents two caveats: closing an app from the app menu fires no callback and can leave an orphaned stream (watch for stale connections and close them after a timeout), and switching to phone audio while computer audio stays connected stops transcripts until the user hangs up the phone or chooses "Leave computer audio" first.

### Before you go live

1. Run `npm run live:check -- --public-url https://<your-host>/webhook` against your production URL (step 3).
2. Give your customers step 4's admin and host instructions. RTMS does not start until their admin enables it.
3. Subscribe to `rtms.request_status` and both concurrency events, and alert on them.
4. Rehearse a purge: stop reason 8 means delete the assets and confirm. The F3 coverage test exercises the service purge flag, deletion confirmations and dashboard alert together.
5. Run a real meeting through `npm run live` and watch every phase, a reconnect, and a stop.

---

## Elsewhere in the guide

Every part, one click away. The [overview](../readme.md) holds the map.

- [00 Design](../00-design/readme.md) - Production architecture: failure drills, media choices, observability, the webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1. What changes, which sample to start from, the gap-checker
- [20 Configure](../20-configure/readme.md) - Step 2. The Marketplace app: manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3. Review, evidence and the rejections to avoid
- [40 Prepare](../40-prepare/readme.md) - Step 4. Admin enablement, host approval, consent, the status codes
- [50 Start And Approval](../50-start-and-approval/readme.md) - Step 5. The webhook endpoint, deduplication, claims, the tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6. Signaling and media sockets, keep-alives, reconnect, generations
- [61 Media And Participants](../61-media-and-participants/readme.md) - Step 6. The participant registry, the camera selector, media profiles
- [The root readme](../readme.md) - the seven steps, the plan and licensing checks, the reuse table

