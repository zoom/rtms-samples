# 10 Integration advisor (Step 1: know what changes)

Meeting SDK bots still work, but Zoom steers new integrations toward RTMS. Before writing code, map your bot's features against what RTMS provides so you catch capability gaps early instead of mid-migration.

**Contents**

- [Start from an existing sample](#start-from-an-existing-sample)
- [Run the gap checker](#run-the-gap-checker)
- [Feature and media mapping](#feature-and-media-mapping)
- [Gains, trade-offs, and current gaps](#gains-trade-offs-and-current-gaps)
- [Common questions](#common-questions)
- [Adapting this sample](#adapting-this-sample)
- [Files and tests](#files-and-tests)

## Start from an existing sample

Pick the closest working sample in `rtms-samples/` and build on it instead of writing the protocol layer from scratch. Paths are relative to the repository root.

| Your bot needs | Start from |
|---|---|
| Full production path: webhook, claim, reconnect, multi-node | `rtms-distributed-sample/` plus `bot-to-rtms-migration/50-start-and-approval` and `60-stream-lifecycle-client` |
| Single-instance audio and transcript capture | `rtms_api/` and `transcript/` (`save_transcript_js`, `send_transcript_to_*`) |
| Audio processing | `audio/` |
| Video or active-speaker handling | `video/` |
| Screen share | `screen_share/` |
| In-meeting chat capture | `chat/` |
| Minimal connection layer | `library/javascript/rtmsManager` with `library/javascript/webhookManager` |
| Durable cloud storage | `storage/save_audio_and_video_to_aws_s3_storage_js` |
| Start/stop controls from a Zoom App or REST | `zoom_apps/start_stop_rtms_control_js`, `rtms_api/manual_start_stop_using_js` |
| Reconnection and chaos testing | `rtms_api/reconnection_and_chaos_mode_js` |

The folders in `bot-to-rtms-migration/` add the migration pieces those standalone samples leave out: webhook hardening, tenant and consent gating, deduplication, per-user OAuth, and audit trails.

## Run the gap checker

[src/advisor.js](src/advisor.js) checks your bot's requirements and tells you which capabilities map to RTMS, which need a companion surface (Meeting SDK or Zoom App), and which fit the Recording REST API instead.

```bash
npm run advise -- --scenario revenue-call-analyzer
npm run advise -- --set botSpeaks,wantsRtmsDataPlane    # custom flags
npm run advise -- --requirements                        # list all flags and defaults
npm run advise -- --capabilities | --media | --assumptions | --belongs
```

The checker evaluates requirements in this order:

1. **No live action needed, or CRM archive only:** use recording webhooks plus the Recording REST API instead of live streaming.
2. **Hard RTMS blocker** (approval flow unacceptable, external customers cannot authorize, ad hoc join by meeting ID/passcode, unsupported raw capture, or simultaneous capture of every camera): keep that path on the Meeting SDK.
3. **Action or presence RTMS lacks** (visible participant tile, speaking, sending chat, host controls, recording control): keep a companion Meeting SDK surface. Add RTMS only if you also want an independent analytics or compliance feed (`wantsRtmsDataPlane`), and share one identity, consent, and audit service across both.
4. **Otherwise:** move to RTMS. Pair it with a Zoom App if users need an in-meeting UI panel, and verify Contact Center entitlement separately if capturing CC voice.

Unknown flag names throw an error so typos fail loudly.

## Feature and media mapping

These tables mirror the data exported by [src/capabilities.js](src/capabilities.js) (printed via `--capabilities`, `--media`, `--assumptions`, and `--belongs`).

### What RTMS replaces

| Former bot capability | RTMS? | Correct approach |
|---|---|---|
| Receive audio, video, share, transcript, chat | Yes | RTMS media sockets and scopes |
| Send chat | No | Meeting SDK, chat integration, or Zoom App UI |
| Play audio into the meeting | No | Meeting SDK audio injection |
| Send video | No | Meeting SDK |
| React, raise hand, change layout | No | Meeting SDK or client integration |
| Mute, rename, admit, remove, cohost | No | Meeting SDK role/permission, or host integration |
| Start or stop Zoom recording | No | Meeting SDK recording controller, or host / REST policy |
| Download cloud recording | No | Recording webhook plus Recording REST API |
| Force approval or bypass denial | No | Fix policy, presence, approval, or entitlement |

### Media parity

| Media | RTMS | Notes |
|---|---|---|
| Mixed audio | Yes | Choose codec, sample rate, channel, and `send_rate` |
| Per-participant audio | Where enabled (`AUDIO_MULTI_STREAMS`) | Validate speaker metadata and channel mapping before migrating |
| Active-speaker video | Yes | Single active stream |
| Individual camera video | One selected participant at a time | Subscribe and unsubscribe by user; multi-camera (up to 4 at 720p) requires server enablement by request |
| Screen share | Yes | Separate stream from camera video |
| Transcript | Yes | Zoom transcript, or send audio to your own ASR |
| Chat | Receive only | Cannot send chat through RTMS |

### Meeting SDK assumptions that change

| Meeting SDK habit | RTMS requirement |
|---|---|
| Bot joins with meeting ID and passcode | No user join; an installed app, eligible user, admin policy, and host approval authorize the feed |
| Presence is a participant tile in the roster | Presence is an authorized feed shown in the active-app indicator |
| Your service decides when to join | Connect only after a product-specific `*_rtms_started` webhook |
| One SDK connection carries everything | One signaling WebSocket plus one media WebSocket per concrete media type |
| SDK manages connections | You own keep-alives, reconnect, backoff, and jitter |
| Bot survives a network blip | Missed reconnect windows end the stream; a new stream needs a new webhook and `rtms_stream_id` |
| SDK callbacks report state | Reconcile webhooks and RTMS state messages by ID and timestamp |
| Local recording bridges outages | Persist and reconcile partial media yourself; `buffer_data` covers a short startup gap only |
| One service account attends any meeting | Every stream binds to a tenant, app user, policy snapshot, and consent reference |
| Raw PCM and YUV frames | Negotiated audio codecs (L16/Opus/G711/G722) and H.264 or JPG frames; persist sequence, timestamp, and user metadata |
| Participants tracked by display name | Use a stream-scoped participant registry keyed by RTMS user ID |
| Control actions bundled in the SDK | RTMS is receive-only; chat, speech, host controls, and recording control require other APIs |

### Which surface owns what

| Capability | RTMS | Meeting SDK | Zoom Apps | Webhooks / REST |
|---|---|---|---|---|
| Receive media | Yes | Yes | Indirect | Async (recordings) |
| Send media | No | Yes | Product-dependent | No |
| Send chat | No | Yes | Product-dependent | Limited |
| Participant tile | No | Yes | No | No |
| Active-app indicator | Yes | Yes | Product-dependent | No |
| Host controls | No | Role-based | Limited | Some APIs |
| Cloud recordings | No | No | No | Yes |

## Gains, trade-offs, and current gaps

**What you gain with RTMS:**

1. No participant join automation (no passcodes, waiting rooms, or client sign-in).
2. Auto-start when an authorized user owns or joins a meeting, including ad hoc meetings off calendar.
3. Admin rollout to users and groups with policy defaults.
4. Persistent host approval via **Always allow in my meetings**.
5. Continuous capture when the meeting owner leaves and transfers host.
6. Lighter infrastructure: no per-meeting browser or desktop client runtime.

**What you give up or rebuild:** speaking, posting chat, host controls, capturing meetings with no authorized user present, unapproved capture (a host can deny), and the WebSocket lifecycle (keep-alives, reconnect, deduplication).

**Current gaps (as of 2026-11-05).** Treat "not documented" as unsupported until Zoom confirms:

| Need | Current status |
|---|---|
| Capture with no authorized user attending or owning ("send my notetaker when I can't attend") | Not documented as supported. REST start requires an invited participant who has joined |
| Breakout rooms or per-room stop | Not documented as supported. Keep a bot for breakout-heavy workflows |
| Zoom Rooms app install and auto-start | Not documented. Test on real hardware before committing |
| Web client guest consent or in-client pause/stop | Partners report gaps. Build pause, resume, and stop controls on the REST status endpoint |
| Posting chat or playing audio into the meeting | Unsupported. RTMS is receive-only |
| Multiple simultaneous individual cameras or AEAD payload encryption | Server features enabled by request, not covered by these samples. Zoom Phone audio and transcript are supported in [library/javascript/rtmsManager](../../library/javascript/rtmsManager/RTMSManager.js) |

## Common questions

**Can RTMS join from a meeting ID and passcode?**
No. RTMS requires an installed app, an eligible app user, admin policy plus any required host approval, and a handshake signature derived from the webhook's meeting ID and stream ID. If your product promises "join any meeting by link", keep the Meeting SDK.

**Does RTMS remove the participant tile?**
Yes, but Zoom displays the app in the meeting's active-app indicator while RTMS runs. Never promise invisible capture in UX copy or legal disclosures.

**How do I replace raw PCM and YUV?**
Choose the audio codec your pipeline expects (L16 PCM for mono, Opus for stereo) and H.264 or JPG frames for video and screen share. Store sequence, timestamp, and user metadata, and do not assume frame order survives reconnects.

**Is RTMS cheaper than a bot?**
Usually for receive-only workloads because you drop the per-meeting client process. Budget for Developer Pack credits, per-socket concurrency limits, and your own media transfer, decode, storage, and AI costs.

**RTMS or cloud recordings?**
Use RTMS when your product acts during the meeting (agent assist, compliance alerts, live translation). Use cloud recordings when post-meeting delay is fine or you need Zoom's canonical file. Many teams pair live RTMS transcripts for in-meeting features with cloud recordings for archival evidence.

**What latency should I expect?**
Typically 40 to 200 ms end to end, depending on distance to Zoom's signaling and media servers. Measure four hops separately: Zoom event to webhook, webhook to signaling connected, media handshake to first packet, and packet to your output.

## Adapting this sample

- **Add custom requirements:** add new flags to `DEFAULT_REQUIREMENTS` and `REQUIREMENT_HELP` in [src/advisor.js](src/advisor.js), then update the decision checklist in `advise()`.
- **Update capability facts:** edit the tables in [src/capabilities.js](src/capabilities.js) when Zoom ships new capabilities so the CLI output and tests stay aligned.

## Files and tests

[cli.js](cli.js), [src/advisor.js](src/advisor.js), [src/capabilities.js](src/capabilities.js), [advisor.test.js](advisor.test.js) (9 tests covering every built-in scenario).

---

## Elsewhere in the guide

Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture, failover drills, media choices, observability, webhook SLO
- [20 Configure](../20-configure/readme.md) - Step 2: Marketplace manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3: review package, checks, common rejections
- [40 Prepare](../40-prepare/readme.md) - Step 4: admin enablement, host approval, consent, status codes
- [50 Start and Approval](../50-start-and-approval/readme.md) - Step 5: webhook intake, claims, tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6: signaling, media, keep-alives, reconnect, manifests
- [61 Media and Participants](../61-media-and-participants/readme.md) - Step 6: participant registry, camera selector, media profiles
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7: dashboard, alerts, event contract, rollout
