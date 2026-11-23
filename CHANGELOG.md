# Changelog

All notable user-facing changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This repository contains samples rather than a versioned package, so changes
remain under **Unreleased** until a repository release is published.

## [Unreleased]

### Added

- Added `zoom_apps/zoom_decisions_compliance_risk_copilot_js`, a Zoom App that uses typed
  decisions to review live transcripts for compliance gaps and risk.
- Added Zoom Phone RTMS support to the JavaScript `RTMSManager`:
  `phone.call_rtms_started`, `phone.call_rtms_stopped`, and
  `phone.call_rtms_interrupted` webhooks, protocol V2 handshakes, `wss://`
  selection from comma-separated `server_urls`, per-channel audio and
  transcript events (`channelId`, `sentenceId`, `isUpdate`), Phone call events
  (`phone_call_info_updated`, `phone_call_hold`, `phone_call_resume`,
  `phone_call_transfer_completed`), `RTMSManager.PRESETS.PHONE`, and
  `RTMSManager.getPhoneCallInfo()`.
- Added `phone/print_phone_transcript_js`, a Zoom Phone transcript sample.
- Added `RTMSManager.EVENT_CODES`, the V2 status codes `44`, `45` and `48` to
  `58`, `REQUEST_ERROR_RESP` handling, and the `video_subscription_terminated`
  and `media_data_user_info` events to the JavaScript `RTMSManager`, with
  matching events in the Python library.

### Changed

- Moved the samples to RTMS protocol V2. The JavaScript and Python
  `RTMSManager` libraries default to `protocol_version: 2` (set
  `protocolVersion: 1` or `protocol_version=1` to opt out), subscribe with
  `event_code`, map incoming `event_code` values to the existing handlers, and
  report both `eventCode` and the legacy `eventType` on `'event'`. The raw
  JavaScript, Python, Go, C++, .NET and Java samples send `protocol_version: 2`
  in both handshakes, use `event_code`, and drop the data handshake
  `payload_encryption` flag.
- Every sample now accepts comma-separated `server_urls` values
  (`wss://...,srt://...`) and connects to the `wss://` entry. A single
  `media_server.server_urls` string is also accepted for every media type.
- `boilerplate/working_python_wss_zoom_room_screenshot` opens a video data
  connection instead of requesting `media_type: 32`.
- `RTMS_CONNECTION_FLOW.md` documents the V2 handshakes, the `event_type` to
  `event_code` mapping, and the new message types.
- RTMS media connections now use split mode exclusively. Clients open a
  separate data connection for each required media type and send one concrete
  `media_type` per data handshake: audio (`1`), video (`2`), screen share (`4`),
  transcript (`8`), or chat (`16`).
- Generic boilerplates now require an explicit comma-separated selection such
  as `RTMS_MEDIA_TYPES=audio,video,transcript`.
- Purpose-built samples select only the media required for their use case.
- Audio/video streaming samples now manage separate audio and video sockets,
  including independent keep-alive and reconnection handling.
- JavaScript and Python shared libraries now require an explicit media
  selection instead of implicitly requesting every media type.

### Deprecated

- Unified media socket mode and aggregate data handshakes using
  `media_type: 32` are deprecated and must not be used by new clients.

### Removed

- Removed `server_urls.all` usage from runnable samples.
- Removed the `MEDIA_SOCKET_CONNECTION_MODE` and `MEDIA_TYPES_FLAG`
  environment settings from generic sample configuration.
- Removed the JavaScript `MEDIA.ALL`, Python `MediaType.ALL`, and JavaScript
  `PRESETS.FULL_MEDIA` public helpers.

### Fixed

- `video-sdk/vsdk_working_java` compiles again: URL validation returns a
  `400` response instead of writing to an undefined servlet response.
- The Java samples store the signaling socket before sending the handshake, so
  the event subscription is no longer lost when the response arrives first.
- The Python `RTMSManager` now connects Zoom Phone streams, which require
  protocol V2.

### Migration

Replace legacy configuration:

```env
MEDIA_SOCKET_CONNECTION_MODE=unified
MEDIA_TYPES_FLAG=32
```

with explicit media names:

```env
RTMS_MEDIA_TYPES=audio,video,transcript
```

For direct WebSocket implementations, use the matching URL and concrete value
for each connection. For example, connect to `server_urls.audio` with
`media_type: 1`, then connect separately to `server_urls.transcript` with
`media_type: 8`.
