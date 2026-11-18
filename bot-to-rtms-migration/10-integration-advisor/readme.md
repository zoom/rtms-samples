# 10 Integration advisor

Meeting SDK bots keep working, but Zoom now steers new integrations to RTMS, so the move is a matter of when, not whether. This folder is information for developers doing that move. It covers the differences, the feature mapping and the sample to start from.

- what changes between the two models
- which of your bot's features have an RTMS equivalent
- which existing sample to start from, so you write as little new connection code as possible

**Contents**

- [Start from an existing sample](#start-from-an-existing-sample) - working repos to build on instead of new connection code
- [What actually changes](#what-actually-changes) - bot vs RTMS, table form
- [Optional gap check](#optional-gap-check) - the `npm run advise` gap-checker
- [Reference tables](#reference-tables) - what RTMS replaces, media parity, assumptions that no longer hold, which surface owns what
- [Adapting this sample](#adapting-this-sample) and [Files and tests](#files-and-tests)
- [Step 1. Know what changes before you write code](#step-1-know-what-changes-before-you-write-code) - the guide's decision chapter: replacement table, the gaps in order, gains and losses, common questions

## Start from an existing sample

Do not write the RTMS flow from scratch. Each of these works today, so pick the closest to your product and build on it.

| Your bot does | Start from |
|---|---|
| Needs the whole production path: webhook, claim, reconnect, multi-instance | `rtms-distributed-sample/` (Zoom's official reference) and this repo's `50-start-and-approval` plus `60-stream-lifecycle-client` |
| One-instance audio and transcript capture | `rtms_api/` and `transcript/` (`save_transcript_js`, `send_transcript_to_*`) |
| Audio processing | `audio/` |
| Video or active-speaker handling | `video/` |
| Screen share | `screen_share/` |
| In-meeting chat capture | `chat/` |
| The smallest working connection layer | `library/javascript/rtmsManager` with `library/javascript/webhookManager` |
| Durable storage of recordings | `storage/save_audio_and_video_to_aws_s3_storage_js` |
| Start/stop controls from a Zoom App or REST | `zoom_apps/start_stop_rtms_control_js`, `rtms_api/manual_start_stop_using_js` |
| Reconnection and chaos testing | `rtms_api/reconnection_and_chaos_mode_js` |

Paths are relative to the repository root (`rtms-samples/`). The folders in this repository add the migration-specific parts those samples do not have. They cover the webhook hardening, the tenant and consent gate, deduplication and the audit trail.

## What actually changes

| A Meeting SDK bot | RTMS |
|---|---|
| Joins from a meeting ID and passcode. | Joins the same meeting as a service, where an installed app, an eligible app user, admin policy and any host approval authorize the feed. |
| Appears as a participant tile. | No tile. Zoom still shows the app in the active-app indicator. |
| Can speak, chat, mute, admit, record. | Receive only. Those actions need the Meeting SDK, a host integration or REST. |
| Gets raw frames for every participant it can see. | Gets negotiated formats, one active-speaker or one selected camera at a time. |

## Optional gap check

[src/advisor.js](src/advisor.js) is a gap-checker, not a decision maker: you tell it what your bot does, it tells you which parts of your current feature set have an RTMS equivalent and which need a companion surface. It exists because the expensive mistake is finding a gap late, not choosing wrong.

```bash
npm run advise -- --scenario revenue-call-analyzer
npm run advise -- --set botSpeaks,wantsRtmsDataPlane          # your own requirements
npm run advise -- --requirements                              # every flag and its default
npm run advise -- --capabilities | --media | --assumptions | --belongs
```

It reads as a checklist, in this order, one item per row.

1. **No live action needed, or CRM archive only** → recording webhooks plus the Recording REST API are enough. Do not pull RTMS in just as a downloader.
2. **A blocker for RTMS** (approval flow unacceptable, external customers cannot authorize, ad hoc join, raw capture gaps, every camera at once) → that part of the product needs a companion while RTMS carries the rest.
3. **A control RTMS lacks** (visible bot, speech, chat, host controls, recording control) → plan the companion surface. Keep RTMS for the data feed if you want it independent (`wantsRtmsDataPlane`).
4. **Otherwise** the whole bot maps onto RTMS, with the conditions the checker names (active-app indicator, Contact Center entitlement, reconnect and tenant policy).

Unknown requirement names throw instead of being ignored.

## Reference tables

The four tables below are the reference data. They also live as data in [src/capabilities.js](src/capabilities.js), where the advisor's `--capabilities | --media | --assumptions | --belongs` flags print them. This readme is the human-readable copy.

### RTMS replacements

| Former bot capability | RTMS? | Correct approach |
|---|---|---|
| Receive audio, video, share, transcript, chat | Yes | RTMS concrete media sockets and scopes |
| Send chat | No | Meeting SDK, chat integration, or Zoom App UI |
| Play audio into the meeting | No | Meeting SDK audio injection |
| Send video | No | Meeting SDK |
| React, raise hand, change layout | No | Meeting SDK or client integration |
| Mute, rename, admit, remove, cohost | No | Meeting SDK role and permission, or host integration |
| Start or stop Zoom recording | No | Meeting SDK recording controller, or host / REST policy |
| Download cloud recording | No | Recording webhook plus Recording REST API |
| Force approval or bypass denial | No | Fix policy, presence, approval or entitlement |

### Media parity with a Meeting SDK bot

| Media | RTMS | Note |
|---|---|---|
| Mixed audio | Yes | Choose codec, sample rate, channel and send interval. |
| Per-participant audio | Where available (AUDIO_MULTI_STREAMS) | Validate speaker metadata and channel mapping before migrating. |
| Active-speaker video | Yes | A single active stream. |
| Individual camera video | One selected participant at a time | Subscribe and unsubscribe by user. Not unlimited simultaneous cameras. |
| Screen share | Yes | A separate stream from camera video. |
| Transcript | Yes | Zoom transcript, or send audio to your own ASR. |
| Chat | Receive only | You cannot send chat through RTMS. |

### Meeting SDK assumptions that change

| Meeting SDK assumption | RTMS requirement |
|---|---|
| The bot joins from a meeting ID and passcode | There is no user join. An installed app, an eligible app user, admin policy and any host approval authorize the feed. |
| Presence is a participant in the roster | Presence is an authorized feed. The app shows only in the client active-app indicator. |
| Your service decides when to join | A product-specific `*_rtms_started` webhook says the stream exists. Do not connect before it. |
| One SDK connection carries everything | One signaling WebSocket plus one media WebSocket per concrete media type. |
| The SDK manages the connection | You own keep-alives, reconnect, backoff and jitter. |
| Bot presence survives a network blip | A stream can stop. A new stream needs a new webhook and a new `rtms_stream_id`. |
| SDK callbacks report state | Webhooks plus RTMS state messages. Reconcile them by ID and timestamp. |
| Local recording continues through an outage | You persist and reconcile partial media yourself. `buffer_data` covers a short startup gap only. |
| A service account can attend any meeting | Every stream ties to a tenant, an app user, a policy snapshot and a consent reference. |
| Raw PCM and YUV frames | Negotiated audio codecs and H.264 or image frames. Persist sequence, timestamp and user metadata. |
| Participants are tracked by display name | Use a stream-scoped participant registry keyed by the RTMS user ID. |
| Control actions come with the SDK | RTMS is receive-only. Chat, speech, host controls and recording control need other APIs. |

### Which surface owns which capability

| Capability | RTMS | Meeting SDK | Zoom Apps | Webhooks/REST |
|---|---|---|---|---|
| Receive media | Yes | Yes | Indirect | Async |
| Send media | No | Yes | Product-dependent | No |
| Send chat | No | Yes | Product-dependent | Limited |
| Participant tile | No | Yes | No | No |
| Active-app indicator | Yes | Yes | Product-dependent | No |
| Host controls | No | Role-based | Limited | Some APIs |
| Recordings | No | No | No | Yes |

## Adapting this sample

- **Start from a sample, not from zero.** Pick the closest row in the table above and read that sample's readme before writing anything here.
- **Your requirements.** Add each new flag to `DEFAULTS` and `REQUIREMENT_HELP` in [src/advisor.js](src/advisor.js), then teach the checklist in the same file. Unknown names throw on purpose, so a typo in a scenario fails loudly.
- **Your capability facts.** The tables in [src/capabilities.js](src/capabilities.js) are the source of truth for what each Zoom surface can do. When Zoom ships a new capability, change the table, not the prose.

## Files and tests

[cli.js](cli.js), [src/advisor.js](src/advisor.js), [src/capabilities.js](src/capabilities.js), [advisor.test.js](advisor.test.js) (9 tests, including every built-in scenario).

---

# Guide part one: the decision

## Step 1. Know what changes before you write code

Meeting SDK bots keep working. RTMS is where new builds end up. Before you write code, map what your bot does today onto what RTMS provides, because some features have no RTMS equivalent and finding that out late is the most expensive mistake in this migration.

### RTMS replacement boundaries

| What your bot did | RTMS? | What to use |
|---|---|---|
| Receive audio, video, screen share, transcript, chat | Yes | RTMS |
| Send chat | No | Meeting SDK, a chat integration, or a Zoom App panel |
| Play audio or send video into the meeting | No | Meeting SDK |
| React, raise a hand, change layout | No | Meeting SDK or a client integration |
| Mute, rename, admit, remove, make cohost | No | Meeting SDK role, or a host integration |
| Start or stop Zoom recording | No | Meeting SDK recording controller, or host and REST policy |
| Download cloud recordings | No | Recording webhook plus the Recording REST API |
| Force an approval or bypass a denial | No | Fix the policy, presence, approval or entitlement |

### Gap assessment order

1. **Nothing has to happen during the meeting.** If you only archive finished meetings to a CRM, recording webhooks and the Recording REST API cover it. Do not pull RTMS in just as a downloader.
2. **Something blocks RTMS.** That part stays on the Meeting SDK for now. Blockers are an approval flow your product cannot accept, customers who cannot install and authorize the app, joining any meeting from only an ID and passcode, raw capture RTMS does not cover, or every camera at once.
3. **Something RTMS lacks** (a visible bot, speech, chat, host controls, recording control). Plan the companion surface for it. Add RTMS as well only if you also want an independent analytics or compliance feed. That combination needs one identity, consent and audit service across both.
4. **Everything else moves to RTMS.** Add a Zoom App if users need a panel inside the meeting. Contact Center voice RTMS needs its own entitlement.

RTMS fits the parts of your product where all of these hold.

- You need inbound media and metadata, not control.
- An admin and host approval flow is acceptable.
- You can operate reconnect, idempotency and tenant policy.
- The bot does not need to speak or chat.
- The media options cover the layout and channels you need.

Everything outside that set needs a companion surface, today on the Meeting SDK, until those features have a replacement.

RTMS is deliberately narrow, only authorized inbound media and metadata. It has no participant runtime and no control surface, so do not force it to own presence, injection or controls. Use RTMS for the data plane, and the Meeting SDK or a Zoom App only for the specific control or UI gap.

The table below shows which surface owns what.

| Capability | RTMS | Meeting SDK | Zoom Apps | Webhooks and REST |
|---|---|---|---|---|
| Receive media | Yes | Yes | Indirect | Async (recordings) |
| Send media | No | Yes | Product-dependent | No |
| Send chat | No | Yes | Product-dependent | Limited |
| Participant tile | No | Yes | No | No |
| Active-app indicator | Yes | Yes | Product-dependent | No |
| Host controls | No | Role-based | Limited | Some APIs |
| Recordings | No | No | No | Yes |

### Gains and losses

**Gain**

1. No participant join flow to automate, so no passcode, waiting room or sign-in handling.
2. Auto-start when a user owns or joins a meeting, including meetings that are not on a calendar.
3. Admin rollout to users and groups, with defaults.
4. A host can approve once and have it persist (**Always allow in my meetings**).
5. An app used by a meeting owner keeps running after the owner leaves and transfers host.
6. Receive-only infrastructure, with no meeting client per meeting.

**Give up or rebuild** — speaking, posting chat and host controls. Meetings where no authorized user is present. Capture that does not depend on permission (a host can deny). And the WebSocket lifecycle, reconnect and deduplication, which become yours.

Not covered yet, as of 2026-11-05. "Not documented" means Zoom's published docs do not say it is supported, so treat it as unsupported until Zoom confirms. The gaps follow.

| You need | Today |
|---|---|
| Capture when no authorized user attends or owns the meeting ("send my notetaker when I can't attend") | Not documented as supported. The app acts for a user, and REST start needs an invited participant who has joined |
| Breakout rooms, or stopping capture in one room | Not documented as supported. Keep the bot for breakout-heavy use cases |
| Zoom Rooms: install an app for a room, auto-start for room-owned meetings | Not documented. Test before you promise it |
| Web client: guest consent flows, in-client pause or stop | Partners report gaps. Build your own pause, resume and stop buttons on the REST status endpoint |
| Posting into chat, bidirectional audio | Not available. RTMS only receives |
| Several individual cameras at once, application-layer encryption | Server features enabled by request, not covered by the samples. Zoom Phone audio and transcript are supported in [library/javascript/rtmsManager](../../library/javascript/rtmsManager/RTMSManager.js) |

### Common questions

**Can RTMS join a meeting from a meeting ID and passcode?** No. A meeting ID and passcode authenticate a participant. RTMS is an authorized data feed, and it needs all of the following.

- an installed app and an eligible app user
- policy, plus any required host approval
- a signature built from the webhook's meeting ID and stream ID

If your product's contract is "join any meeting", keep the Meeting SDK, or first establish an authorized way to start RTMS.

**Does RTMS remove the participant tile?** Yes. But the app still appears in the meeting client's active-app indicator while RTMS is running. Design your user experience and legal text around visible activity. Do not promise invisible capture.

**Can it capture the same media as my bot?**

| Media | RTMS |
|---|---|
| Mixed audio | Yes. You choose codec, sample rate, channels and send interval |
| Per-participant audio | Where enabled. Validate speaker metadata and channel mapping first |
| Active-speaker video | Yes, as one stream |
| Individual camera video | One selected participant at a time. Subscribe and unsubscribe by user |
| Screen share | Yes, a separate stream from camera video |
| Transcript | Yes, from Zoom, or send the audio to your own speech recognition |
| Chat | Receive only |

**How do I replace raw PCM and YUV?** For audio, pick the codec your pipeline supports. L16 (PCM) is common, and stereo needs Opus. For video and screen share use H.264, or image frames where that fits. Keep sequence, timestamp and user metadata, and do not assume frame order survives a reconnect.

**Can I capture every participant's camera at once?** Not with unlimited individual streams. Use active-speaker video, or the one-selected-participant pattern. If you truly need every camera, check the current limit or keep the Meeting SDK's raw video. For webinars, design around panelist media first and test attendee visibility before you promise it.

**Is RTMS cheaper than a bot?** Usually for receive-only work, because there is no full client. It is not free, because the Developer Pack or RTMS entitlement applies, concurrent streams are limited, and media transfer, decoding, storage and AI still cost money. Several media sockets per stream raise the real stream count, so meter per tenant and per stream.

**RTMS or cloud recordings?** Use RTMS when the product must act during the meeting (agent assist, compliance prompts, live dashboards, translation). Use recordings when minutes of delay is fine, or when you need Zoom's canonical file. A hybrid is common, live transcript for action and the recording as evidence.

**What latency should I expect?** Expect about 40 to 200 ms on average, depending on how far your server sits from Zoom's signaling and media servers. RTMS removes the bot's join and capture overhead but adds a webhook hop and WebSocket hops. Do not promise real-time guarantees. Measure four things separately:

- Zoom event to your webhook
- webhook to signaling connected
- media handshake to first packet
- packet to your result

---

## Elsewhere in the guide

All nine parts link below. Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture. Failure drills, media choices, observability, the webhook SLO
- [20 Configure](../20-configure/readme.md) - Step 2. The Marketplace app: manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3. Review, evidence and the rejections to avoid
- [40 Prepare](../40-prepare/readme.md) - Step 4. Admin enablement, host approval, consent, the status codes
- [50 Start And Approval](../50-start-and-approval/readme.md) - Step 5. The webhook endpoint, deduplication, claims, the tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6. Signaling and media sockets, keep-alives, reconnect, generations
- [61 Media And Participants](../61-media-and-participants/readme.md) - Step 6. The participant registry, the camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7. The dashboard, alerts, the event contract, the production checklist
- [The root readme](../readme.md) - the seven steps, the plan and licensing checks, the reuse table

