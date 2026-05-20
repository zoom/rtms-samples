# Regional Compute Job

[Back to distributed sample overview](../README.md)

This is the per-stream worker. It claims the stream lease, starts `RTMSManager`, receives media/lifecycle events, records final media artifacts, updates live state, and exits after stop.

Model:

```text
one RTMS stream attempt = one Kubernetes Job = one active pod
```

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Worker state and config |
| `GET /local/streams` | Local test/debug stream state |
| `POST /compute/webhook` | Start or stop envelope |

## Run Locally

```bash
SPOKE_REGION=IAD \
COMPUTE_PORT=4300 \
REGIONAL_STORE_URL=http://127.0.0.1:4101 \
CENTRAL_STORE_URL=http://127.0.0.1:4100 \
ARTIFACT_STORAGE_URL=http://127.0.0.1:4550 \
REALTIME_CACHE_URL=http://127.0.0.1:4560 \
npm run start:compute
```

## Startup Sources

The worker can load the accepted webhook in three ways:

| Mode | Config |
|------|--------|
| HTTP envelope | `POST /compute/webhook` |
| Stored envelope | `RTMS_STREAM_ID` + `RTMS_ENVELOPE_REF` + `REGIONAL_STORE_URL` |
| Mounted file | `RTMS_ENVELOPE_FILE=/var/run/rtms/envelope.json` |

## Media Recording

When `MEDIA_RECORDING_ENABLED=true`, the worker writes temporary chunks locally, finalizes them, and uploads final files through [`08-artifact-storage`](../08-artifact-storage/README.md).

Expected outputs:

- `manifest.json`
- final `.wav` for audio
- final `.mp4` for video

The compute pod does not need to know whether final storage is local disk, MinIO, S3, Azure Blob, or Google Cloud Storage.

## Main Config

| Key | Purpose |
|-----|---------|
| `MEDIA_TYPES_FLAG` | `32` for all media, `3` audio+video, `9` audio+transcript |
| `MEDIA_SOCKET_CONNECTION_MODE` | RTMS media socket mode, default `split` |
| `AUDIO_STREAM_MODE` | `mixed` by default |
| `VIDEO_STREAM_MODE` | `active` by default |
| `LEASE_TTL_MS` | Lease expiry, default `45000` |
| `LEASE_RENEW_INTERVAL_MS` | Lease renewal interval, default `15000` |
| `ARTIFACT_STORAGE_URL` | Artifact API URL |
| `REALTIME_CACHE_URL` | Realtime cache URL |
| `RTMS_SECRET_DIR` | Mounted secret directory for Zoom credentials |

## Related

- [Compute launcher](../04-regional-compute-launcher/README.md)
- [Artifact storage](../08-artifact-storage/README.md)
- [Realtime cache](../06-realtime-cache/README.md)
- [Secret helper](../shared/README.md)
