# 61 Media and participants (Step 6: participants and cameras)

Maps what a Meeting SDK bot consumed (raw PCM/YUV frames, a participant roster, and simultaneous cameras) onto RTMS equivalents: negotiated media parameters, a stream-scoped participant registry keyed by RTMS user ID, mixed-audio speaker attribution, and single-camera video subscriptions.

**Contents**

- [Run this folder alone](#run-this-folder-alone)
- [How media handling differs from a bot](#how-media-handling-differs-from-a-bot)
- [Core components](#core-components)
- [Run inside the live service](#run-inside-the-live-service)
- [Webinars](#webinars)
- [Adapting this sample](#adapting-this-sample)
- [Files and tests](#files-and-tests)

## Run this folder alone

```bash
npm run demo:61    # offline canned stream: participants, video subscription, media profiles
npm run test:61    # unit tests and edge cases
```

No environment variables are needed. `demo:61` feeds canned RTMS events through the participant registry and video-subscription manager, builds negotiated audio/video parameters, translates a sample Meeting SDK raw config with `fromSdkRaw()`, and prints frame/audio attributions.

## How media handling differs from a bot

| Meeting SDK bot | RTMS |
|---|---|
| Raw PCM samples and YUV frames per participant | Negotiated audio codecs (L16, Opus, G711, G722) and H.264 or JPG video frames; your pipeline decodes and muxes |
| Roster keyed by display name | Stream-scoped registry keyed by RTMS user ID (display names repeat and change) |
| Per-participant audio and every visible camera | Mixed audio attributed via active-speaker events (per-participant audio only where enabled) and one selected camera at a time |
| Leaving ends only that participant | Leaving closes their presence, video, and speaking intervals and clears any active video subscription while the stream continues |

### Three pipeline changes

1. **You own decoding.** Validate and lock codecs with `buildMediaParams()` or `fromSdkRaw()` before connecting.
2. **YUV becomes H.264.** You receive an encoded bitstream where I frames stand alone and P frames depend on prior frames. Segment boundaries, post-gap recovery, and seeking must wait for the next I frame; a dropped P frame corrupts subsequent frames until the next I frame resets the picture.
3. **You own attribution.** Match mixed audio timestamps to active-speaker intervals and video frames to the currently confirmed subscription. Bind per-participant audio sockets/channels directly to the registry rather than guessing.

The lifecycle client in `60-stream-lifecycle-client` handles segment boundaries, parameter changes, gaps, and chunk dedupe; your storage writer hooks `onPacket`.

## Core components

### Participant registry ([src/participants.js](src/participants.js))

Create one registry per stream (`tenant + meeting UUID + rtms_stream_id`). All presence, video-on, and speaking intervals use Zoom's stream clock (event and packet timestamps) so they align with media packets.

- Keyed by RTMS user ID. Duplicate joins do not duplicate people; a join with a new name logs a rename. Two present users named "Sam" receive unique labels `Sam (id 1002)` and `Sam (id 1003)`.
- Leaving closes presence, video, and speaking intervals and notifies listeners of `video_off` before `leave`.
- Mixed audio attribution checks active-speaker intervals only. Silence returns `null` (`no_active_speaker`) instead of guessing the previous speaker.
- Individual video frames are attributed only when the user's video interval covers the frame timestamp. Departed users never receive frames.
- Users first observed on video-on or active-speaker events are marked `implicit` and `present` until a real join clears `implicit`, ensuring a subsequent leave event still closes their intervals cleanly.
- `linkZoomAppParticipant(uuid, userId)` maps Zoom App participant UUIDs to stream-scoped RTMS user IDs (never join RTMS user IDs across different streams, as they are only unique within a meeting). Roles are not included in these RTMS events, so feed them via `setRole()`.
- `finalize(ts)` closes open intervals at the final stream timestamp and returns the `participants` block for `manifest.json`.

### Video subscription manager ([src/videoSubscription.js](src/videoSubscription.js))

Tracks `current` (server-confirmed) and `desired` user IDs with at most one `VIDEO_SUBSCRIPTION_REQ` in flight, switching cameras by unsubscribing `current` before subscribing `desired`.

- Rejects users whose video is off, and drops a queued subscribe if their video turns off before sending.
- When the currently subscribed person turns video off or leaves, clears `current` without sending an unsubscribe (Zoom already ended it) and keeps the stream alive. Set `afterVideoEnds: 'next'` to switch automatically to another user with video on.
- On video socket reconnect (`handleVideoSocketRecovered()`), re-subscribes the desired user because the old connection's subscription is lost.
- If a subscribe times out, sends a cleanup unsubscribe before starting another request so server state stays deterministic.
- `attributeFrame()` rejects and counts frames not matching `current`.

### Media profile ([src/mediaProfile.js](src/mediaProfile.js))

Builds `media_params` per concrete media type and rejects invalid settings before connecting: stereo requires Opus, fps must be an integer from 1 to 30 for both video and screen share, and PNG is rejected under protocol V2 (use `jpg` or `h264`). `fromSdkRaw()` translates a Meeting SDK raw audio/video specification into RTMS parameters and prints migration notes.

## Run inside the live service

These components are already wired into [60-stream-lifecycle-client/src/liveSession.js](../60-stream-lifecycle-client/src/liveSession.js):

```bash
RTMS_MEDIA=audio,transcript npm run live                               # participants and active speaker
RTMS_MEDIA=audio,video RTMS_VIDEO_MODE=individual npm run live         # single selected camera
```

- Live logs show `participant join`, `participant leave`, `participant rename`, and (in individual video mode) `video_subscription_*` trace events.
- With `RTMS_VIDEO_MODE=individual`, the session subscribes to the first participant with video on, switches on `video_off` or `leave`, and re-subscribes after video socket reconnects.
- Configure formats via `RTMS_AUDIO_*`, `RTMS_VIDEO_*`, and `RTMS_TRANSCRIPT_*`. Invalid combinations fail at startup before opening sockets.

On your first live video run, confirm that your meeting emits individual-video events and inspect the status codes returned on any refused subscription (the manager treats any non-zero status as a failure and cleans up).

## Webinars

Build around panelist media first. Attendee streams may not be individually available in webinars, so test attendee visibility on a real webinar before promising it.

## Adapting this sample

- **Media formats:** tune `RTMS_AUDIO_*`, `RTMS_VIDEO_*`, and `RTMS_TRANSCRIPT_*`, or adjust defaults in [src/mediaProfile.js](src/mediaProfile.js).
- **Camera selection policy:** change `afterVideoEnds` and the user-selection rule in [liveSession.js](../60-stream-lifecycle-client/src/liveSession.js) while keeping the single-in-flight state machine in [src/videoSubscription.js](src/videoSubscription.js).
- **Identity and roles:** wire `linkZoomAppParticipant()` and `setRole()` to your session store.
- **Attribution invariants:** keep the guarantees tested in [media.test.js](media.test.js) (no frames attributed to departed users, no speaker guessed during silence).

## Files and tests

- Source: [src/participants.js](src/participants.js), [src/videoSubscription.js](src/videoSubscription.js), [src/mediaProfile.js](src/mediaProfile.js), [offlineDemo.js](offlineDemo.js), [demo.js](demo.js).
- Tests (`npm run test:61`, 15 tests): [demo.test.js](demo.test.js) (1 test), [media.test.js](media.test.js) (14 tests covering registry, subscription state machine, and V2 media profiles).

---

## Elsewhere in the guide

Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture, failover drills, media choices, observability, webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1: what changes, starter samples, gap checker
- [20 Configure](../20-configure/readme.md) - Step 2: Marketplace manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3: review package, checks, common rejections
- [40 Prepare](../40-prepare/readme.md) - Step 4: admin enablement, host approval, consent, status codes
- [50 Start and Approval](../50-start-and-approval/readme.md) - Step 5: webhook intake, claims, tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6: signaling, media, keep-alives, reconnect, manifests
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7: dashboard, alerts, event contract, rollout
