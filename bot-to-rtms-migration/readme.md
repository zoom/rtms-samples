# Moving a Meeting SDK bot to Zoom RTMS

This guide is for teams running a Meeting SDK bot (a participant that joins meetings to transcribe, record, analyze, or assist) who want to replace it with Zoom Realtime Media Streams (RTMS). Start here for the overview, licensing checks, and folder map. Each step's instructions and code documentation live in its numbered folder.

**Contents**

- [How RTMS differs from a Meeting SDK bot](#how-rtms-differs-from-a-meeting-sdk-bot)
- [The seven steps](#the-seven-steps)
- [Before you start](#before-you-start)
- [Folder map](#folder-map)
- [Other samples to reuse in this repo](#other-samples-to-reuse-in-this-repo)

## How RTMS differs from a Meeting SDK bot

A Meeting SDK bot joins a meeting as a user. RTMS connects to the meeting as a service with no participant tile and no roster entry. Zoom pre-authorizes the stream: your app must be installed, the user must be eligible, an admin policy must allow it, and the meeting host may need to approve each meeting.

Your client ID and client secret only sign the WebSocket handshake. Zoom notifies you via webhook when a stream exists, and you connect then.

| Area | Meeting SDK bot | RTMS |
|---|---|---|
| Joining | Meeting ID, passcode, and signed token as a user | No user join. Installation, policy, and host approval authorize the stream; credentials sign the handshake |
| Visibility | Participant tile | No tile; Zoom shows the app in the active-app indicator |
| Starting | Your service decides when to join | Zoom decides; connect only after a verified `*_rtms_started` webhook |
| Connections | One connection managed by the SDK | One signaling socket plus one media socket per media type; you manage keep-alives, reconnect, backoff, and deduplication |
| Actions | Speak, chat, mute, admit, record | Receive only; actions require the Meeting SDK, a Zoom App, or REST |
| Tenancy | One service account | Every stream ties to a tenant, a policy snapshot, and a consent decision |

## The seven steps

```text
 1 KNOW        What changes from a bot, which features map to RTMS, and which sample to start from
 2 CONFIGURE   Create the Marketplace app: manifest, scopes, event subscriptions, and credentials
 3 PUBLISH     Prepare review evidence so other accounts can install the app
 4 PREPARE     Admin enablement, host approval, invitations, and status codes
 5 START       Verify webhooks, deduplicate, claim streams, gate tenants, and start via REST
 6 CONNECT     Signaling and media sockets, keep-alives, reconnect, generations, participants, cameras
 7 OPERATE     Reporting dashboard, alerts, multi-tenancy, capacity, and rollout
```

Each step has its own numbered folder inside `bot-to-rtms-migration/`:

- `00-design` covers production backend architecture (no code).
- `10-integration-advisor` is step 1.
- `20-configure`, `30-publish`, and `40-prepare` are steps 2 through 4 (configuration, review, and admin policy; no code).
- `50-start-and-approval` is step 5.
- `60-stream-lifecycle-client` and `61-media-and-participants` are step 6.
- `70-reporting-dashboard` is step 7.

Every folder's readme covers how to run the code and an **Adapting this sample** section showing where to wire it into your product.

## Before you start

Confirm commercial access first. RTMS requires Zoom Developer Pack credits or an RTMS entitlement arranged with Zoom sales, and your account or sub-account needs Realtime Media Streams enabled before any stream will connect. Basic accounts are unsupported. Step 4 covers account enablement in detail.

For a smaller starting point, two existing options in this repo already work:

- **Reference manager:** `library/javascript/rtmsManager` with `library/javascript/webhookManager` provides a compact connection layer.
- **Published SDK:** `@zoom/rtms` (currently on protocol V1; check upstream before relying on V2 features).

Use `60-stream-lifecycle-client` here when you want protocol V2, stream generations, manifests, recovery windows, and artifact records wired into one service.

### Run the tests offline

Requires Node 18 or newer.

```bash
cd bot-to-rtms-migration
npm install
npm test          # 113 tests, runs in a few seconds with no network
```

Step 1 (`npm run advise`), the offline demos (`demo:03`, `demo:60`, `demo:61`), and the reporting dashboard (`demo:70`, `start:70 -- --sample`) all run without Zoom credentials. Steps 5 and 6 form one live service: `npm run live` receives real Zoom webhooks and connects to Zoom's RTMS servers.

Verify your own tenant, policies, and network path with a real meeting before production. See [Test coverage](60-stream-lifecycle-client/readme.md#test-coverage) for what the automated suite and local mock cover versus what requires a live Zoom meeting.

## Folder map

Start at the top and open each folder's readme when you reach that step.

| Step | Folder | Contents |
|---|---|---|
| Before | [00-design](00-design/readme.md) | Production architecture, failover drills, media choices, observability, webhook SLO (no code) |
| 1 Know | [10-integration-advisor](10-integration-advisor/readme.md) | Bot-to-RTMS differences, feature mapping, existing samples, gap checker (`npm run advise`) |
| 2 Configure | [20-configure](20-configure/readme.md) | Marketplace app manifest, scopes, event subscriptions, credentials (no code) |
| 3 Publish | [30-publish](30-publish/readme.md) | App review package, TLS and domain checks, common rejections (no code) |
| 4 Prepare | [40-prepare](40-prepare/readme.md) | Admin enablement, host approval, consent, `rtms.request_status` and REST error codes (no code) |
| 5 Start | [50-start-and-approval](50-start-and-approval/readme.md) | Webhook endpoint, deduplication, claim leases, tenant gate, per-user OAuth, live bridge |
| 6 Connect | [60-stream-lifecycle-client](60-stream-lifecycle-client/readme.md) | Signaling and media sockets, keep-alives, reconnect windows, generations, manifest, transcript revisions |
| 6 Connect | [61-media-and-participants](61-media-and-participants/readme.md) | Participant registry, single-camera subscription manager, media parameter validation |
| 7 Operate | [70-reporting-dashboard](70-reporting-dashboard/readme.md) | Static HTML/JSON reporting dashboard, alerts, event contract, production checklist, rollout |

Shared helpers live in `shared/`: protocol code tables (`codes.js`), webhook signature verification (`webhookSignature.js`), payload normalization (`rtmsPayload.js`), claim leases (`claims.js`), tenant gate (`tenantGate.js`), logging (`log.js`), and the JSON-lines event trace (`trace.js`).

## Other samples to reuse in this repo

Paths are relative to the `rtms-samples` repository root. Reuse these instead of rebuilding them.

| Use case | Sample path |
|---|---|
| Tile-free AI assistant, notes, summaries | `zoom_apps/ai_industry_specific_notetaker_js`, `transcript/send_transcript_to_claude_js`, `transcript/send_transcript_to_openai_js`, `transcript/save_transcript_js` |
| Compliance copilot | `zoom_apps/zoom_decisions_compliance_risk_copilot_js`, `zoom_apps/prompt_for_user_consent_js` |
| Agent assist | `zoom_apps/ai_rag_customer_support_js`, `zoom_apps/ai_transcript_analysis_js` |
| Enterprise capture and CRM sync | `storage/save_audio_and_video_to_aws_s3_storage_js` |
| Contact Center agent assist | No RTMS sample here. Contact Center voice uses engagement events and CC APIs; see `zoom/zcc-javascript-quickstart` and `zoom/zcc-nextjs-sample` on GitHub and confirm entitlement first |
| Start and stop from a Zoom App or REST | `zoom_apps/start_stop_rtms_control_js`, `rtms_api/manual_start_stop_using_js` |
| Reconnection and chaos testing | `rtms_api/reconnection_and_chaos_mode_js` |
| Reference connection library | `library/javascript/rtmsManager`, `library/javascript/webhookManager` |
