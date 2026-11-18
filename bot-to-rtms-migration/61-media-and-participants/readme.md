# 61 Media and participants

## Run this folder alone

**Contents**

- [Run this folder alone](#run-this-folder-alone) and [Meeting SDK bot vs RTMS](#meeting-sdk-bot-vs-rtms) - commands, then what changes in your pipeline
- [The parts](#parts) - participant registry, camera selector, media profiles
- [Run inside the full service](#run-inside-the-full-service) and [Adapting this sample](#adapting-this-sample)
- [Webinars](#webinars) and [files and tests](#files-and-tests)
- [Guide part six: participants and cameras](#guide-part-six-participants-and-cameras) - the rules for identity, attribution and the one-camera rule


```bash
npm run demo:61    # offline canned stream: participants, video subscription and media profiles
npm run test:61    # the same components plus edge cases
```

No environment is required. `demo:61` feeds a fixed event and media sequence through the participant registry and video-subscription manager, negotiates audio and video parameters, translates an example Meeting SDK configuration, and prints the attributions. Expect two participants, two subscription requests, selected and unselected frames, speaker-derived audio attribution, and the numeric RTMS media parameters.

Maps what a Meeting SDK bot consumed (raw PCM and YUV, a participant roster, per-person video) onto what RTMS delivers, namely negotiated media formats, a stream-scoped participant registry, mixed-audio speaker attribution, and one camera at a time.

## Meeting SDK bot vs RTMS

| A Meeting SDK bot | RTMS |
|---|---|
| Raw PCM and YUV frames. | A negotiated audio codec, sample rate and channels. H.264 video or image frames. You decode in your pipeline. |
| A roster with display names. | Track people by RTMS user ID. Names repeat and change. |
| Per-participant audio and every camera it can render. | Mixed audio (speaker from active-speaker events), per-participant audio only where enabled, and **one** selected individual camera at a time. |
| A participant leaving ends only that person. | Same, but you must close their intervals and clear a video subscription that depended on them. The stream continues. |

### Pipeline changes

The SDK hands you decoded, ready-to-use data, raw PCM samples and YUV frames, one callback per participant, no container. RTMS hands you encoded chunks instead, L16 or Opus audio and H.264 video bitstreams on type-scoped sockets, plus the muxing problem the SDK never gave you. Three shifts follow.

1. **You own decoding.** Pick codecs your pipeline can decode and lock them with `fromSdkRaw()` before the first byte.
2. **YUV becomes H.264.** No more per-frame pixels. You receive a bitstream with keyframes only where the encoder put them, so do not expect to cut or seek on any frame.

    - An I frame stands alone and starts a new group.
    - A P frame depends on the frames before it, so segment starts, dropped stretches and post-gap recovery all wait for an I frame.
    - The upside is bandwidth a raw or intra-only pipeline cannot match.
    - The cost is that dependency chain. A corrupted or missing P frame does not just lose that frame, it smears into everything built on it until the next I frame resets the picture.
3. **Attribution becomes your bookkeeping.** Match audio frames to active-speaker intervals and video frames to the current subscription, both covered above.

The stream client records segment boundaries, parameter changes, gaps and dedupes replays. The writer that turns packets into a file stays yours, hooking `onPacket` in 60-stream-lifecycle-client.

## Parts

**Participant registry** ([src/participants.js](src/participants.js)). One registry per stream: tenant, meeting UUID, `rtms_stream_id`. Keyed by user ID. Records presence, video-on and speaking intervals on the **stream clock** (event and packet timestamps), so they line up with the media.

- A duplicate join is not a second person. A join with a new name is a rename. Two people called "Sam" stay two people and get labels `Sam (id 1002)` and `Sam (id 1003)` while both are present.
- Leaving closes presence, video and speaking, and tells listeners video ended before it says they left.
- Mixed audio is attributed from active-speaker intervals only. With no active speaker the answer is "nobody", never "the last person who talked".
- Video frames are accepted only while the person's video interval covers the frame. A departed person gets nothing by position or from a stale cache.
- Someone first seen on a video event is marked `implicit` until a real join arrives.
- `linkZoomAppParticipant(uuid, userId)` keeps the explicit Zoom App participant UUID to RTMS user ID mapping. The RTMS user ID is unique within its meeting only - not a global ID - so every mapping and interval lives inside one stream's registry and is never joined across streams. Roles are not carried by the RTMS events used here, so `setRole()` takes them from your own source.
- `finalize(ts)` closes every open interval and returns the `participants` block for the stream manifest.

**Video subscription manager** ([src/videoSubscription.js](src/videoSubscription.js)). Keeps `current` (confirmed) and `desired`, never more than one request in flight, and takes the next single step: unsubscribe the current person, then subscribe the next.

- Refuses someone whose video is off, and drops a pending subscribe if their video went off while waiting.
- If the selected person turns video off or leaves, it clears the selection without sending anything (the server already ended it) and the stream continues. `afterVideoEnds: 'next'` selects another person whose video is on.
- If the video socket reconnects, the old subscription is gone, so it subscribes again.
- A subscribe that times out may or may not have taken effect, so it sends a cleanup unsubscribe before trying anything else.
- `attributeFrame()` counts frames that are not for the current subscription instead of attributing them.

**Media profile** ([src/mediaProfile.js](src/mediaProfile.js)). Builds `media_params` per concrete media type and refuses invalid combinations (stereo needs Opus, fps range, unknown codec). `fromSdkRaw()` turns what your bot consumed into RTMS parameters and says what changes. The accepted values mirror the constants in Zoom's reference manager. [src/mediaProfile.js](src/mediaProfile.js) is the in-repo source of truth.

## Run inside the full service

These parts are wired into the live session, so they run on a real stream with `npm run live` (setup is in the "Connect to Zoom" section of the 50-start-and-approval readme):

```bash
RTMS_MEDIA=audio,transcript npm run live                               # participants and active speaker
RTMS_MEDIA=audio,video RTMS_VIDEO_MODE=individual npm run live         # one camera at a time
```

- The registry fills from the participant and speaker events the client subscribes to. The log shows `participant join`, `participant leave` and `participant rename` with RTMS user IDs, and the finished `manifest.json` carries a `participants` block with every presence, video and speaking interval.
- With `RTMS_VIDEO_MODE=individual` the live session selects the first person whose video is on, switches to another when that person turns video off or leaves, and subscribes again if the video socket reconnects. The log carries the subscription outcomes as `video_subscription_*` trace events.
- `RTMS_AUDIO_*`, `RTMS_VIDEO_*` and `RTMS_TRANSCRIPT_*` set the negotiated formats. [src/mediaProfile.js](src/mediaProfile.js) refuses invalid combinations before anything connects, and `fromSdkRaw()` maps what your bot consumed today onto RTMS parameters.

Two things to confirm on your first real run, because they depend on Zoom's behavior and not on this code. One is whether a given meeting actually sends the individual-video events. The other is what status Zoom returns for a refused subscription. The subscription manager treats any non-zero status as a failure and cleans up, so it does not depend on a specific code.

## Adapting this sample

- **Media formats.** Set `RTMS_AUDIO_*`, `RTMS_VIDEO_*` and `RTMS_TRANSCRIPT_*`, or edit [src/mediaProfile.js](src/mediaProfile.js) to change the defaults. Invalid combinations are refused before connecting, so a wrong codec fails fast and locally. Use `fromSdkRaw()` to translate what your old bot consumed.
- **Camera policy.** Who gets the single video slot is your product decision. The selector in [src/videoSubscription.js](src/videoSubscription.js) picks the first person whose video is on. Change `afterVideoEnds` and the selection rule, not the one-request-at-a-time machinery around it.
- **Identity.** `linkZoomAppParticipant()` joins your Zoom App user to the RTMS user ID, and `setRole()` takes roles from your own source, because RTMS events do not carry them. Wire both to your session store.
- **Attribution rules.** Speaker attribution and video-frame gating live in [src/participants.js](src/participants.js). The invariants (departed people get nothing, no speaker means nobody) are tested in [media.test.js](media.test.js). Keep them while you extend.

## Webinars

Design around panelist media first. Attendee streams may not be individually available, so test attendee visibility before you promise webinar capture.

## Files and tests

[src/participants.js](src/participants.js), [src/videoSubscription.js](src/videoSubscription.js), [src/mediaProfile.js](src/mediaProfile.js), [offlineDemo.js](offlineDemo.js), [demo.js](demo.js), [demo.test.js](demo.test.js) (1 test), [media.test.js](media.test.js) (14 tests: registry, subscription manager, media profile).

---

## Guide part six: participants and cameras

### Participants and cameras

- **Identify people by their RTMS user ID, never by display name.** Names repeat and change. Keep a registry per stream, closed intervals for presence, video-on and speaking, all on the stream clock (the event and packet timestamps).
- **Mixed audio.** Attribute a frame to the active-speaker interval that covers its timestamp. Do not guess from silence, because with no active speaker the answer is "nobody".
- **Per-participant audio.** Bind the socket and channel metadata to the registry, not to a guess. For a Zoom App user, keep an explicit map from the Zoom App participant UUID to the RTMS user ID. RTMS does not replace your identity resolution, so duplicate names and renames need your own handling.
- **One camera at a time.** To switch, unsubscribe the current person, then subscribe the next. Keep one request in flight. If the selected person turns video off or leaves, clear the selection (Zoom already ended it) and carry on. If the video socket reconnects, subscribe again. Never attribute a frame to someone who is not the current subscription.
- **If a subscribed participant leaves,** only that person's video interval ends. Close it, remove them from the selection and keep the stream.
- **Formats.** `RTMS_AUDIO_*`, `RTMS_VIDEO_*` and `RTMS_TRANSCRIPT_*` set what you negotiate, and invalid combinations (stereo without Opus, an fps out of range) are refused before anything connects.

---

## Elsewhere in the guide

All nine parts link below. Start from the [overview](../readme.md).

- [00 Design](../00-design/readme.md) - Production architecture: failure drills, media choices, observability, the webhook SLO
- [10 Integration Advisor](../10-integration-advisor/readme.md) - Step 1. What changes, which sample to start from, the gap-checker
- [20 Configure](../20-configure/readme.md) - Step 2. The Marketplace app: manifest, scopes, events, credentials
- [30 Publish](../30-publish/readme.md) - Step 3. Review, evidence and the rejections to avoid
- [40 Prepare](../40-prepare/readme.md) - Step 4. Admin enablement, host approval, consent, the status codes
- [50 Start And Approval](../50-start-and-approval/readme.md) - Step 5. The webhook endpoint, deduplication, claims, the tenant gate, OAuth
- [60 Stream Lifecycle Client](../60-stream-lifecycle-client/readme.md) - Step 6. Signaling and media sockets, keep-alives, reconnect, generations
- [70 Reporting Dashboard](../70-reporting-dashboard/readme.md) - Step 7. The dashboard, alerts, the event contract, the production checklist
- [The root readme](../readme.md) - the seven steps, the plan and licensing checks, the reuse table

