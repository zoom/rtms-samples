# Zoom Phone RTMS Transcript

Receives live [Zoom Phone RTMS](https://developers.zoom.us/docs/rtms/phone/)
streams and prints call transcripts, transcript revisions, and call events.

> Built with [RTMSManager](../../library/javascript/readme.md#zoom-phone). The
> manager handles signaling, protocol V2 handshakes, media sockets,
> keep-alives, client-ready ACKs, failover, and reconnection.

## What It Does

- Starts a stream for each `phone.call_rtms_started` webhook.
- Prints each transcript sentence with the speaker name from
  `CALL_INFO_UPDATED`, falling back to the channel ID.
- Replaces revised sentences keyed by `(channelId, sentenceId)` instead of
  appending duplicates.
- Logs participant changes, hold, resume, and transfer events.
- Counts raw PCM audio bytes per channel and prints a summary when the call ends.

## Prerequisites

- Node.js 20 or newer.
- A Zoom Developer Pack with RTMS credits and a Zoom Phone license for each
  participating user.
- A Zoom Marketplace **General app** with:
  - Scopes `phone:read:voice_call_audio` and `phone:read:voice_call_transcript`.
  - Event subscriptions `phone.call_rtms_started`, `phone.call_rtms_stopped`,
    and `phone.call_rtms_interrupted`.
- RTMS turned on for the target users in their phone policy, with the app
  selected and **Automatic start** enabled. See
  [Adding RTMS to your app](https://developers.zoom.us/docs/rtms/phone/add-features/).
- A public HTTPS URL for the webhook.

## Configure

```bash
npm install
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `ZOOM_CLIENT_ID` | App Client ID from **Basic Information** |
| `ZOOM_CLIENT_SECRET` | App Client Secret; signs RTMS handshakes |
| `ZOOM_SECRET_TOKEN` | Webhook Secret Token from **Access**; verifies webhooks |
| `PORT` | HTTP port, default `3000` |
| `WEBHOOK_PATH` | Webhook route, default `/webhook` |
| `LOG_TRANSCRIPT_TEXT` | Set `false` to log lengths instead of call content |

Keep `.env` private; it is excluded by `.gitignore`.

## Run

```bash
npm test
npm start
```

Expose the port over HTTPS (for example `ngrok http 3000`) and set the app's
event notification endpoint to `https://YOUR_DOMAIN/webhook`. Place a call
from an RTMS-enabled Zoom Phone user.

```text
[Phone] call-id participants: Alice (ch-a, host), pstn (ch-b)
[Phone] call-id new #0 Alice: Thanks for calling.
[Phone] call-id updated #0 Alice: Thanks for calling. How can I help?
[Phone] call-id call on hold
```

`GET /healthz` reports the number of active streams.

## Using RTMSManager For Phone

```javascript
await RTMSManager.init({
  ...RTMSManager.PRESETS.PHONE,
  credentials: { phone: { clientId, clientSecret, secretToken } }
});

RTMSManager.on('transcript', ({ channelId, userName, sentenceId, isUpdate, text }) => {});
RTMSManager.on('audio', ({ channelId, buffer }) => {});
RTMSManager.on('phone_call_info_updated', ({ hostChannelId, participants }) => {});
```

For an RTMS Phone stream, `rtmsId` is the `call_id`. Phone audio is raw PCM per
channel; confirm the sample rate before converting it to WAV.

## Files

| File | Purpose |
|---|---|
| `index.js` | Webhook endpoint, RTMSManager setup, and event logging |
| `phoneTranscript.js` | Applies new sentences and revisions by `(channelId, sentenceId)` |
| `phoneTranscript.test.js` | Revision-handling tests |

## References

- [Working with Phone streams](https://developers.zoom.us/docs/rtms/phone/work-with-streams/)
- [Handling transcript updates](https://developers.zoom.us/docs/rtms/phone/transcript-updates/)
- [Zoom Phone events](https://developers.zoom.us/docs/rtms/event-reference/phone-events/)
- [Failover and reconnection](https://developers.zoom.us/docs/rtms/phone/failover-reconnection/)
