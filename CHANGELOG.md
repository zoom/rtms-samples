# Changelog

All notable user-facing changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This repository contains samples rather than a versioned package, so changes
remain under **Unreleased** until a repository release is published.

## [Unreleased]

### Added

- Added `zoom_apps/zoom_decisions_compliance_risk_copilot_js`, a Zoom App that uses typed
  decisions to review live transcripts for compliance gaps and risk.

### Changed

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
