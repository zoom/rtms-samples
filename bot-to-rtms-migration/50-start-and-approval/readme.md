# 50 Start and approval (Step 5)

Receives RTMS lifecycle webhooks safely, enforces deduplication, tenant/consent gating, and claim leases, manages per-user OAuth tokens, and initiates REST start, stop, pause, and resume requests. This service opens no WebSockets itself; it hands verified, claimed streams to [60-stream-lifecycle-client](../60-stream-lifecycle-client/readme.md).

**Contents**

- [Run this folder alone](#run-this-folder-alone)
- [How webhook intake differs from a bot](#how-webhook-intake-differs-from-a-bot)
- [Webhook processing flow and deduplication](#webhook-processing-flow-and-deduplication)
- [Handing streams to workers](#handing-streams-to-workers)
- [Two users in one meeting and capture filters](#two-users-in-one-meeting-and-capture-filters)
- [Starting and controlling streams via REST](#starting-and-controlling-streams-via-rest)
- [Per-user OAuth and deauthorization](#per-user-oauth-and-deauthorization)
- [Connect to live Zoom](#connect-to-live-zoom)
- [Swap points for production](#swap-points-for-production)
- [Adapting this sample](#adapting-this-sample)
- [Files and tests](#files-and-tests)

## Run this folder alone

```bash
npm run demo:03        # offline: signed webhooks, dry-run REST, no credentials
npm run live:check     # validates .env without printing secrets
npm run live           # live server: webhook -> claim -> live RTMS client
```

- `demo:03` replays a scripted set of signed webhooks in-process with a throwaway secret and dry-run REST, then prints the decisions. Pass `-- --write-trace` to also append those events to `.data/events.jsonl` for the reporting dashboard.
- `live:check` prints `[ ok ]`, `[info]`, `[warn]`, and `[FAIL]` checks and exits nonzero only on a `FAIL`. Pass `-- --public-url https://<your-host>/webhook` to probe your public URL with Zoom's `endpoint.url_validation` challenge.
- `live` binds to `HOST` (`127.0.0.1`) on `PORT_03` (`4803`) and requires `ZOOM_SECRET_TOKEN`, `ZOOM_CLIENT_ID`, and `ZOOM_CLIENT_SECRET`. All operator routes (`/api/*`) require `ADMIN_API_TOKEN` as a `Bearer` token; the server fails closed with HTTP `503` if `ADMIN_API_TOKEN` is unset.

## How webhook intake differs from a bot

| Meeting SDK bot | RTMS |
|---|---|
| Your service decides when to join and joins once | Zoom sends `*_rtms_started` webhooks and retries them on timeout or non-200 |
| A second join creates a second participant | A second connection for the same stream kicks the first; deduplicate before connecting |
| No approval gate | Starts can be denied, delayed, or blocked by policy; `rtms.request_status` explains why |
| One service account | Every stream belongs to a tenant with a policy snapshot and consent reference |

## Webhook processing flow and deduplication

```text
POST /webhook
  |-- verify x-zm-signature on RAW body, 300 s timestamp tolerance -> 401 (webhook_rejected)
  |-- parse JSON                                                   -> 400
  |-- endpoint.url_validation                                      -> 200 { plainToken, encryptedToken }
  |-- dedupe: event + account + meeting + stream + event_ts, and x-zm-request-id
  |     already seen (kept 65 min)                                 -> 200 { status: "duplicate" }
  v  200 { status: "accepted" }   <-- HTTP response sent before downstream work
  |
  |-- *.rtms_started (including contact_center.voice_rtms_started and phone.call_rtms_started)
  |     tenant/consent gate -> capture filter -> meeting policy -> claim(tenant|product|meeting|stream)
  |       filtered out or rival live -> stream_refused + onStreamDeclined (stops via REST)
  |       claimed or superseded      -> onStreamReady(stream)
  |       hand-off throws            -> claim abandoned, stream_start_failed, alert
  |       same owner, already live   -> stream_refresh (moves to new server_urls; no second socket)
  |       held by another worker     -> duplicate_stream_dropped
  |       stream already finished    -> late_duplicate_dropped
  |-- *.rtms_stopped       -> decideStop(reason), release claim, purge + alert on reason 8
  |-- *.rtms_interrupted   -> record event; current owner recovers it (never open a second connection)
  |-- rtms.request_status  -> 7 pauses starts until reboot time, 8 resumes, unknown alerts
  '-- rtms.concurrency_near_limit / _limited
        shed noncritical starts near the limit; block all at the limit.
        Stopping or releasing a stream at the limit drops level to "near" (shedding expires after 5 min without a fresh event).
```

### Started webhook payload

Zoom sends product-specific event names (`meeting.rtms_started`, `webinar.rtms_started`, `session.rtms_started`, `contact_center.voice_rtms_started`, `phone.call_rtms_started`). For meetings, expect `account_id`, `meeting_id`, `meeting_uuid`, `operator_id`, `rtms_stream_id`, `server_urls`, and `is_original_host`. Video SDK sends `session_id`; Phone sends `call_id`; Contact Center sends `engagement_id`.

Persist the raw webhook payload as your recovery record instead of rebuilding fields from REST APIs. [shared/rtmsPayload.js](../shared/rtmsPayload.js) normalizes flat and `payload.object` shapes while keeping `raw` intact.

### Three deduplication layers

| Layer | Key | Behavior |
|---|---|---|
| Webhook | `event + account + meeting/session + rtms_stream_id + event_ts` plus `x-zm-request-id` | First delivery wins; retries drop cleanly for at least 65 minutes (covering Zoom's ~1 hour retry horizon) |
| Connection | `tenant + product + meeting + rtms_stream_id` | One lease owner at a time. Unrenewed leases expire so crashed workers do not lock streams. Takeover increments a fencing generation, fencing out the old owner. Finished streams stay tombstoned |
| Artifact | `chunk_id = sha256(tenant + meeting + stream + mediaType + timestamp + bytes)`, `final_id = tenant + meeting + artifactType + generation` | Reprocessed chunks never duplicate; never deduplicate by meeting UUID alone |

### Lifecycle rules

- Connect only after a verified, deduplicated, claimed `*_rtms_started` webhook.
- Pauses are recoverable inside the same stream; stops are terminal for that `rtms_stream_id`.
- Reconcile `rtms.request_status`, lifecycle webhooks, and WebSocket stream/session states as separate evidence keyed by IDs and timestamps.
- `rtms.concurrency_near_limit` sheds noncritical starts; `rtms.concurrency_limited` blocks new starts until capacity frees. If you hit limits regularly, request a higher account limit from Zoom sales or support.

## Handing streams to workers

`onStreamReady(stream)` connects a claimed stream to a worker or queue. In `npm run live`, [src/liveBridge.js](src/liveBridge.js) opens the live session in-process, forwards failover `rtms_started` events via `onStreamRefresh` so sockets move to new `server_urls`, finalizes and purges artifacts on stop webhooks via `onStreamStopped`, and releases the claim when the session ends.

Two invariants keep claims accurate:

- **Abandon failed hand-offs:** if `onStreamReady` throws, the service abandons the claim with no tombstone, logs `stream_start_failed`, and raises an alert so a subsequent webhook can retry.
- **Release finished streams:** call `service.releaseStream(streamId, reason)` when a client exits for any reason. This stops lease renewal, frees a concurrency slot if at the limit, and tombstones the stream so late duplicate webhooks cannot reopen it.

## Two users in one meeting and capture filters

Zoom handles one common duplicate case before webhooks ever reach your server:

- **Same account, same Marketplace app (host + participant):** When a host and a participant under the same Zoom account start the same RTMS Marketplace app, Zoom sends only **one** `meeting.rtms_started` event. This deduplication is by design.
- **Host auto-start attribution:** If the original host configured auto-start for that app, the host's `user_id` (`operator_id`) always appears in the `meeting.rtms_started` webhook payload. Expect the host's ID rather than the participant's.

Your own webhook and connection deduplication stops retries of that single stream. `MEETING_POLICY` handles the remaining multi-user cases where Zoom does emit separate streams with different `operator_id`s (such as users from different accounts or separate participant starts when the host did not start the app).

### Meeting policy (`MEETING_POLICY`)

| Policy | Behavior |
|---|---|
| `first_wins` (default) | Opens the first stream and declines any other user's stream for the same tenant, product, and meeting while the first is live |
| `keep_both` | Opens every stream (each consumes concurrency slots and credits) |

Details:

- A restart by the same `operator_id` with a new `rtms_stream_id` is allowed even before the prior claim releases.
- If `operator_id` is absent, the service cannot distinguish users and does not refuse.
- Rival checking and claiming run synchronously with no `await` in between, preventing concurrent webhooks for the same meeting from both winning.
- Declined streams log `stream_refused` (`duplicate_meeting_stream`) and invoke `onStreamDeclined`. In `npm run live`, that hook calls REST `stop` using the declined user's token unless `STOP_DECLINED_STREAMS=false`.

### Capture filter (`CAPTURE_FILTER_MODULE`)

Auto-start filters only by meeting category, not custom business rules (such as "only meetings on a customer calendar"). Point `CAPTURE_FILTER_MODULE` to a module with a default export:

```js
// my-filter.js
export default async function capture({ tenantId, meetingId, meetingNumericId, operatorId, originalHost }) {
  const expected = await myCalendar.hasEvent(tenantId, meetingId);
  return expected ? true : { capture: false, reason: 'not_on_calendar' };
}
```

- Returns `true`, `false`, or `{ capture, reason }` (sync or async).
- Runs after the tenant gate and before claiming; declined streams trigger `stream_refused` (`filtered_out`) and `onStreamDeclined`.
- Never re-runs on a refresh webhook for an already-live stream.
- Fails open if the filter throws: logs `capture_filter_failed`, raises an alert, and captures the stream rather than silently dropping a meeting.
- Verify billing behavior with Zoom before relying on immediate REST stop for cost control.

## Starting and controlling streams via REST

`requestStart({ meetingId, participantUserId, accountId, policy, critical })` runs five steps:

1. Checks the tenant and consent gate. Refused accounts never call Zoom.
2. Checks capacity (`startsAllowed()`): pauses during scheduled server updates (status 7), sheds noncritical starts near the concurrency limit, and blocks at the limit.
3. Builds and logs an audit snapshot (meeting ID, target user, client ID, policy snapshot, authorization verdict, tenant, consent reference, requested media, timestamp).
4. Sends `PATCH /live_meetings/{meetingId}/rtms_app/status` with `{ action: "start", settings: { client_id, participant_user_id? } }` through [src/retryingRestClient.js](src/retryingRestClient.js) (which retries HTTP `429` using `Retry-After` or jittered backoff) and classifies the response (`204`, `3000`/`4927`, `13267`, `13262`, `2308`/`2309`, `2312`, `13273`, `13277`, `404`, `429`).
5. Arms a watchdog (default 60 s). If neither a matching `*_rtms_started` nor `rtms.request_status` arrives in time, it logs `start_watchdog_fired` with the diagnostic audit order and raises `started_webhook_missing`. Never poll Zoom to recover a missing webhook.

With neither `ZOOM_REDIRECT_URI` nor `ZOOM_ACCESS_TOKEN` configured, the REST client runs in dry-run mode without network calls.

`requestStop` and `requestControl('pause' | 'resume', ...)` call the same endpoint with `action: "stop"`, `"pause"`, or `"resume"`, letting you build pause/resume controls for clients that lack them (such as web clients).

## Per-user OAuth and deauthorization

Because RTMS acts for a specific Zoom user, REST start, stop, pause, and resume require that user's OAuth token. [src/oauth.js](src/oauth.js) manages one token record per user:

```text
user -> GET /oauth/authorize              -> Zoom consent screen
Zoom -> GET /oauth/callback?code&state    -> exchanges code, identifies user, stores tokens
REST -> accessToken(userId)               -> returns token, refreshing 60 s before expiry
Zoom -> POST /oauth/deauthorize           -> verifies signature, deletes user's tokens
```

- **Refresh and rotation:** access tokens last 1 hour; refresh tokens last 90 days and rotate on every refresh. Concurrent callers for the same user share one in-flight refresh, and the newest refresh token is persisted every time.
- **Reauthorization:** if Zoom rejects a refresh (`400`/`401`) or a token lacks scopes listed in `OAUTH_REQUIRED_SCOPES`, the user is marked `reauthorization_required`. Subsequent REST calls fail locally with no network retry until the user authorizes again. Transient `5xx` refresh errors do not flag the user.
- **API 401 handling:** a `401` from Zoom forces one refresh and retries once; a second `401` marks the user `reauthorization_required`.
- **User lookup:** after exchanging the authorization code, `oauth.js` calls `GET /users/me` (requires `user:read:user`) unless you supply `userId`.
- **Callback state check:** `GET /oauth/authorize` mints a single-use CSRF `state` with a 10-minute TTL. If `/oauth/callback` receives a `state` parameter, it verifies it strictly and returns `400` on invalid or expired states. When a user clicks Marketplace's own Authorize button, Zoom redirects with `?code` and no `state`; the callback detects the missing `state` and exchanges the code directly (`marketplace-initiated authorization`).
- **Deauthorization:** point your app's deauthorization URL at `POST /oauth/deauthorize`. Only a validly signed `app_deauthorized` payload matching your `ZOOM_CLIENT_ID` deletes the user's tokens. Delete the user's remaining product data too.
- **Status report:** `GET /api/oauth/users` (requires `ADMIN_API_TOKEN`) returns per-user authorization state and counts without exposing tokens.

Configure `ZOOM_REDIRECT_URI` to match your Marketplace callback URL. Tokens default to owner-only files (`0600`) in `OAUTH_TOKEN_DIR` for development, or in memory with `OAUTH_STORE=memory`. Swap in your secret manager or encrypted database in production using the same `get`, `set`, `delete`, `list` interface.

## Connect to live Zoom

1. **Credentials:** `cp .env.example .env` and set `ZOOM_SECRET_TOKEN`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, and `ADMIN_API_TOKEN`. Keep `.env` out of git.
2. **Allow your account:** set `TENANT_ACCOUNT_IDS` to your Zoom account ID (or point `TENANTS_FILE` at a tenant JSON file). If you do not know your account ID yet, start the server, trigger one stream, copy `accountId` from the `stream_refused` log line, set `TENANT_ACCOUNT_IDS`, and restart.
3. **Media selection:** set `RTMS_MEDIA` (default `audio,transcript`) and `RTMS_VIDEO_MODE` (`activeSpeaker` or `individual`). See `.env.example` for codec and reconnect window overrides.
4. **Verify settings and webhook URL:** run `npm run live:check`, expose `POST <WEBHOOK_PATH>` on `PORT_03` behind HTTPS (keep `HOST=127.0.0.1`), and run `npm run live:check -- --public-url https://<your-host>/webhook`.
5. **Validate in Marketplace:** save the webhook URL under Features > Access, subscribe to `meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.rtms_interrupted`, `rtms.request_status`, `rtms.concurrency_near_limit`, and `rtms.concurrency_limited`, and wait for the green validation check.
6. **Start the service:** run `npm run live`, start a meeting with RTMS enabled (or call `POST /api/start`), and watch JSON logs progress through `listening for Zoom webhooks`, `connecting to the RTMS signaling server`, `phase signaling_connected`, `media_connected`, `client_ready_sent`, `streaming`, periodic `stats`, `participant join`, and `stream finished` with the `manifest.json` path.

Inspect live state at `GET /api/state`. Press Ctrl-C to send `STREAM_CLOSE_REQ` on all active streams before exit. Transcript text is omitted from logs by default; set `RTMS_PRINT_TRANSCRIPT=true` to log it or `RTMS_SAVE_TRANSCRIPT=true` to write `transcript.jsonl` beside `manifest.json`.

### Live troubleshooting (observed issues)

- **Meeting already ended:** Zoom accepts `PATCH .../rtms_app/status` for an ended meeting but never sends `rtms_started`, leaving the meeting blocked as `already_pending` until the watchdog fires (or you restart the process).
- **`started_webhook_missing` alert:** check for dry-run mode (no token), an ended meeting, an account missing from `TENANT_ACCOUNT_IDS`, or a rotated `ZOOM_SECRET_TOKEN` causing `401` rejections.
- **Immediate stop-then-restart race:** stopping and immediately restarting are two separate requests; the replacement `rtms_started` can miss while the first generation tears down. Retry once with backoff instead of assuming the meeting ended.
- **Use numeric meeting IDs for REST:** URL-encoded meeting UUIDs returned Zoom code `300` (`Invalid meeting id`) on lifecycle stops, whereas numeric meeting IDs succeeded.
- **Meetings surface disabled:** if the Meetings checkbox under Marketplace Surface is off, Zoom accepts starts and emits no webhooks.

![Marketplace Surface page with Meetings enabled for the RTMS app](../docs/screenshots/21-surface-meetings-enabled.png)

- **Webhook URL edited:** in development, regenerate the authorization URL and reinstall the app after changing the webhook URL; in production, resubmit for approval.
- **Check Marketplace delivery logs:** verify whether Zoom delivered the webhook before debugging your code.
- **Bad client secret:** webhooks still succeed when `ZOOM_CLIENT_SECRET` is wrong; failures appear during the signaling/media handshakes afterward.
- **Green check but silent:** re-run URL validation in Marketplace after any secret or proxy change and verify `Zoom Marketplace/1.0a` hits in your proxy access log.

## Swap points for production

| In this sample | In production |
|---|---|
| In-memory dedupe set and claim registry | Shared store: atomic unique-key insert in your DB or Redis `SET key owner NX PX leaseMs` so multiple replicas never double-open a stream |
| In-process lease heartbeat every `CLAIM_LEASE_MS / 3` | Same contract; fenced workers stop using the stream immediately |
| JSON-lines trace file | Your structured logging or event pipeline |
| [tenants.sample.json](tenants.sample.json) | Your tenant install, policy, and consent database |
| Dispatch runs after 200 in the same process | Enqueue verified events onto a durable per-stream queue before returning 200 |
| `onStreamReady` starts the client in-process | Enqueue work for stream workers and call `releaseStream()` when workers finish |

## Adapting this sample

- **Tenant and consent gate:** replace the tenant lookup in [src/service.js](src/service.js) with your install and consent store while keeping the verdict contract (`ok`, `tenantId`, `consentRef`, `policyVersion`).
- **Worker hand-off:** replace `onStreamReady` in [src/liveBridge.js](src/liveBridge.js) with your job queue producer and call `releaseStream()` on worker completion.
- **Tenant config:** copy [tenants.sample.json](tenants.sample.json) to `tenants.json` and point `TENANTS_FILE` at it.
- **OAuth storage:** swap `fileTokenStore` in [src/oauth.js](src/oauth.js) for your secret store or encrypted DB table using the `get`/`set`/`delete`/`list` contract.
- **Multi-instance scaling:** move dedupe and claims to a shared store before running more than one replica.

## Files and tests

- Source: [server.js](server.js), [check.js](check.js), [demo.js](demo.js), [src/service.js](src/service.js), [src/liveBridge.js](src/liveBridge.js), [src/restClient.js](src/restClient.js), [src/retryingRestClient.js](src/retryingRestClient.js), [src/oauth.js](src/oauth.js), [src/probes.js](src/probes.js), [tenants.sample.json](tenants.sample.json).
- Tests (`npm run test:50`, 51 tests):
  - [service.test.js](service.test.js) (31 tests): signature checks, retries, refresh, multi-worker fencing, failed hand-offs, release, late revoked alerts/purges, request status, concurrency shedding, REST outcomes, watchdogs, meeting policy, capture filters, pause/resume, per-user tokens.
  - [liveBridge.test.js](liveBridge.test.js) (8 tests): stop webhook manifest write, retry/refresh handling, credential failure cleanup, refused accounts, shutdown, live config parsing.
  - [oauth.test.js](oauth.test.js) (11 tests): state TTL, code exchange, refresh rotation, reauthorization flags, signed deauthorization, file store permissions.
  - [probes.test.js](probes.test.js) (1 test): URL validation probe against a local server.

---

## Elsewhere in the guide

Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture, failover drills, media choices, observability, webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1: what changes, starter samples, gap checker
- [20 Configure](../20-configure/readme.md) - Step 2: Marketplace manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3: review package, checks, common rejections
- [40 Prepare](../40-prepare/readme.md) - Step 4: admin enablement, host approval, consent, status codes
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6: signaling, media, keep-alives, reconnect, manifests
- [61 Media and Participants](../61-media-and-participants/readme.md) - Step 6: participant registry, camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7: dashboard, alerts, event contract, rollout
