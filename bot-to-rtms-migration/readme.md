# Moving a Meeting SDK bot to Zoom RTMS

This guide is for those who run a Meeting SDK bot today (a participant that joins meetings to transcribe, record, analyze or assist) and want to replace it with Zoom Realtime Media Streams (RTMS). This readme is the overview. Each step's details live in that step's folder, listed in the table below.

**Contents**

- [The shift in one page](#the-shift-in-one-page) - bot vs RTMS, the whole difference in a paragraph
- [The seven steps](#the-seven-steps) and [before you try anything](#before-you-try-anything) - the plan overview, then the licensing checks
- [Readme per step](#readme-per-step) - the folder table, the real table of contents
- [Other use cases already in this repo](#other-use-cases-already-in-this-repo) - samples to reuse instead of rebuild

## The shift in one page

A Meeting SDK bot **joins a meeting as a user**. RTMS **joins the same meeting as a service**, with no participant or roster. Zoom **pre-authorizes the stream**. Your app must be installed and its user eligible, an admin policy must allow it, and sometimes the meeting's host must approve that meeting's stream, each time.

The client ID and secret only sign the handshake. When the stream exists, a webhook tells you, and you connect to it.

| | Your Meeting SDK bot | RTMS |
|---|---|---|
| Joining | A meeting ID, a passcode and a signed token, as a user | No user. Installation, policy and approval pre-authorize the stream, and your credentials only sign the handshake |
| Visibility | A participant tile | No tile, only a spot in the active-app indicator that you cannot hide |
| Starting | Your service decided when to join | Zoom decides. You connect only after a verified `rtms_started` webhook |
| Connections | One, handled by the SDK | A signaling socket plus one media socket per media type, with keep-alives, reconnect, backoff and deduplication kept alive by you |
| Acting | Speak, chat, mute, record | Receive only. Those actions need another API |
| Tenancy | One service account | Every stream belongs to a tenant, a policy snapshot and a consent decision |

## The seven steps

```text
 1 KNOW        Meeting SDK bots remain supported, but new builds belong on RTMS: what changes, and where to start
 2 CONFIGURE   Create the Marketplace app with manifest, scopes, events and credentials
 3 PUBLISH     Get the app through review so other accounts can install it
 4 PREPARE     Admin enablement, host approval and invitations, per meeting
 5 START       Take the webhook safely, claim the stream, start on purpose
 6 CONNECT     Signaling, media, keep-alives, recovery, participants, cameras
 7 OPERATE     Dashboard, capacity, tenants, consent, versions, going live
```

Every folder sits directly in the repository root, and its number is its step. `00-design` holds the production architecture reading. `10-integration-advisor` is step 1. `20-configure`, `30-publish` and `40-prepare` are the no-code steps. `50-start-and-approval` is step 5. `60-stream-lifecycle-client` and `61-media-and-participants` are step 6. `70-reporting-dashboard` is step 7.

Every folder carries a readme that says how to run it and, in Adapting this sample, exactly where to adapt it to your product.

## Before you try anything

RTMS is not on every plan by default. Confirm the commercial side first: RTMS access is arranged with Zoom sales, and your account or sub-account needs a developer setup that includes Realtime Media Streams before anything here can connect. Step 4 covers the account-level enablement in detail.

You do not have to start from this repository. Two existing resources work today:

- **The reference manager**, `library/javascript/rtmsManager` in this repo (with `library/javascript/webhookManager`), a compact, working connection layer.
- **The RTMS SDK**, Zoom's published client for the protocol, if you prefer a supported package.

This repository's `60-stream-lifecycle-client` is a fuller service built on the same protocol: generations, manifests, recovery and the artifact record. Read those two first if you want the smallest moving thing. Come here when you need the whole path.

Node 18 or newer.

```bash
cd bot-to-rtms-migration
npm install
npm test          # 115 tests, a few seconds, no network
```

Step 1 and the dashboard in step 7 run offline with no credentials. Steps 2 to 4 are configuration and people, so there is no code for them. Steps 5 and 6 are one live path: `npm run live` takes your real webhooks and connects to Zoom's real RTMS servers.

One honest caveat. The connection code follows the library in `library/javascript/rtmsManager`, which already works with Zoom, but nothing in this folder has yet been connected to a real Zoom stream. Treat your first live meeting as the real test, and see **What is verified** in the [60-stream-lifecycle-client](60-stream-lifecycle-client/readme.md) readme.

---
## Readme per step

Each step lives in its own folder, and each folder's readme is both the guide for that step and the documentation for the code in it. It carries what to do, why, the questions people ask at that point, and the files, tests and settings. Start at the top. Read a folder's readme when you reach that step.

| Step | Folder | What is in it |
|---|---|---|
| Before | [00-design](00-design/readme.md) | The production architecture reading. No code |
| 1 Know the shift | [10-integration-advisor](10-integration-advisor/readme.md) | What changes, which existing samples to build on, the gap-checker (`npm run advise`) |
| 2 Configure | [20-configure](20-configure/readme.md) | The Marketplace app: manifest, scopes, events, credentials. No code |
| 3 Publish | [30-publish](30-publish/readme.md) | Review, evidence and the rejections to avoid. No code |
| 4 Prepare | [40-prepare](40-prepare/readme.md) | Admin enablement, host approval, consent, the status codes. No code |
| 5 Start | [50-start-and-approval](50-start-and-approval/readme.md) | The webhook endpoint, deduplication, claims, the tenant gate, OAuth, the live bridge |
| 6 Connect | [60-stream-lifecycle-client](60-stream-lifecycle-client/readme.md) | Signaling and media sockets, keep-alives, reconnect, generations, the manifest |
| 6 Connect | [61-media-and-participants](61-media-and-participants/readme.md) | The participant registry, the camera selector, media profiles |
| 7 Operate | [70-reporting-dashboard](70-reporting-dashboard/readme.md) | The report and dashboard, alerts, the event contract, production checklist |

Every readme also has an Adapting this sample section that says exactly where to adapt the sample to your product.

## Other use cases already in this repo

These have working samples elsewhere in this repo (paths from the repo root), so they are not rebuilt here.

| Use case | Look at |
|---|---|
| Tile-free AI assistant, notes, summaries | `zoom_apps/ai_industry_specific_notetaker_js`, `transcript/send_transcript_to_claude_js`, `transcript/send_transcript_to_openai_js`, `transcript/save_transcript_js` (durable capture, duplicate-event suppression) |
| Compliance copilot | `zoom_apps/zoom_decisions_compliance_risk_copilot_js`, `zoom_apps/prompt_for_user_consent_js` (waits for consent, pauses when someone joins) |
| Agent assist | `zoom_apps/ai_rag_customer_support_js`, `zoom_apps/ai_transcript_analysis_js` |
| Enterprise capture and CRM sync | `storage/save_audio_and_video_to_aws_s3_storage_js` (finalize and upload through a durable queue) |
| Contact Center agent assist | No RTMS sample here. Contact Center voice uses engagement events and the CC APIs, not the meeting RTMS flow. See `zoom/zcc-javascript-quickstart` and `zoom/zcc-nextjs-sample` on GitHub, and validate the engagement event coverage and entitlement first |
| Start and stop from a Zoom App, or by REST | `zoom_apps/start_stop_rtms_control_js`, `rtms_api/manual_start_stop_using_js` |
| Reconnection and chaos testing | `rtms_api/reconnection_and_chaos_mode_js` |
| The reference library | `library/javascript/rtmsManager`, `library/javascript/webhookManager` |

Shared code (`shared/`): the code tables for status, stop reason and message types, webhook signing and verification, the claim registry, the tenant gate and the event trace.
