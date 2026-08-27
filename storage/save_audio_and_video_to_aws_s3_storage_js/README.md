# Archive Zoom Meeting Media to Amazon S3

This sample records mixed Zoom meeting audio and active-speaker video through RTMS, finalizes the media with FFmpeg, and uploads it to Amazon S3 through a durable, recoverable queue.

## Architecture

1. RTMS audio and video are written to stream-specific local files.
2. `meeting.rtms_stopped` stops the video filler and explicitly flushes that stream's files.
3. A durable job is atomically written under `recordings/.upload-queue`.
4. FFmpeg converts PCM and H.264 and creates `mixed_final.mp4` when both tracks exist.
5. Finalized files are streamed to S3. Large files use multipart upload with bounded concurrency.
6. Completed and failed local media is cleaned according to the configured retention policy.

There is no fixed post-meeting delay. Different meetings have independent write streams, and stopping one stream does not close another meeting's files.

## Prerequisites

- Node.js 22 or newer
- A Zoom app with RTMS enabled
- Event subscriptions for `meeting.rtms_started` and `meeting.rtms_stopped`, or a configured Zoom event WebSocket
- An existing S3 bucket
- FFmpeg on `PATH` for direct host execution

The Docker image installs a pinned Debian FFmpeg package, so a separate FFmpeg installation is not required in the container.

## Setup

```bash
npm ci
cp .env.example .env
node index.js
```

For webhook mode, configure the Marketplace webhook endpoint as your public base URL plus `WEBHOOK_PATH`.

## AWS Authentication

The code does not set an AWS credential provider. `S3Client` uses the standard AWS SDK for JavaScript credential-provider chain, including:

- IAM roles for ECS tasks or EC2 instances
- Web identity credentials for EKS and other OIDC environments
- IAM Identity Center and shared AWS config/credential files
- `credential_process`
- Standard `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional session-token variables

Prefer short-lived role credentials over static keys. `AWS_PROFILE` can select a local shared profile. See [AWS SDK credential configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

Uploads require:

- `s3:PutObject`
- `s3:AbortMultipartUpload`

Add `s3:ListBucketMultipartUploads` and `s3:ListMultipartUploadParts` only if your operational tooling lists incomplete multipart uploads.

SSE-KMS also requires appropriate `kms:GenerateDataKey` and `kms:Decrypt` access to the configured key.

## Configuration

### Zoom and Runtime

| Variable | Default | Purpose |
|---|---:|---|
| `ZOOM_SECRET_TOKEN` | required | Verifies Zoom webhook deliveries |
| `ZOOM_CLIENT_ID` | required | Zoom app client ID |
| `ZOOM_CLIENT_SECRET` | required | Zoom app client secret |
| `PORT` | `3000` | HTTP port |
| `WEBHOOK_PATH` | `/webhook` | Webhook route |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | `300` | Signed-webhook replay window |
| `RTMSTRIGGERMANAGERTYPE` | `webhook` | `webhook` or `websocket` |
| `zoomWSURLForEvents` | empty | Zoom event WebSocket URL when using WebSocket mode |
| `MEDIA_SOCKET_CONNECTION_MODE` | `split` | RTMS media socket mode |
| `MEDIA_TYPES_FLAG` | `3` | Audio and video media bitmask |
| `RECORDINGS_DIR` | `recordings` | Local media and durable queue root |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable path |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | SIGINT/SIGTERM graceful-shutdown deadline |

Optional S2S and Video SDK credentials remain documented in `.env.example` for the shared trigger infrastructure.

### S3 Upload

| Variable | Default | Purpose |
|---|---:|---|
| `AWS_REGION` | SDK configuration | S3 region; may also come from shared AWS configuration |
| `S3_BUCKET` | required | Destination bucket |
| `S3_PREFIX` | `rtms` | Object-key prefix |
| `AWS_MAX_ATTEMPTS` | `3` | AWS SDK request attempts |
| `S3_MULTIPART_PART_SIZE_MB` | `16` | Multipart part size, minimum 5 MiB |
| `S3_MULTIPART_CONCURRENCY` | `4` | Concurrent uploaded parts per file |
| `S3_SERVER_SIDE_ENCRYPTION` | `AES256` | Explicit `AES256`, `aws:kms`, or `aws:kms:dsse` encryption |
| `S3_KMS_KEY_ID` | empty | KMS key ID, alias, or ARN for KMS modes |
| `S3_BUCKET_KEY_ENABLED` | `true` | Enables an S3 Bucket Key for KMS modes |

Every upload explicitly requests server-side encryption rather than depending only on bucket defaults. See [SSE-S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-s3-encryption.html) and [SSE-KMS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html).

### Queue and Retention

| Variable | Default | Purpose |
|---|---:|---|
| `UPLOAD_QUEUE_CONCURRENCY` | `1` | Concurrent recording jobs |
| `UPLOAD_MAX_ATTEMPTS` | `5` | Processing attempts before permanent failure |
| `UPLOAD_RETRY_BASE_SECONDS` | `5` | Initial retry delay |
| `UPLOAD_RETRY_MAX_SECONDS` | `300` | Maximum exponential-backoff delay |
| `RECOVERY_STALE_AFTER_MINUTES` | `10` | Media inactivity required before orphan recovery |
| `RECOVERY_SCAN_INTERVAL_MINUTES` | `5` | Orphan scan frequency; `0` disables scheduled scans |
| `DELETE_LOCAL_AFTER_UPLOAD` | `true` | Remove local media immediately after successful upload |
| `COMPLETED_MEDIA_RETENTION_HOURS` | `24` | Completed-media retention when immediate deletion is disabled |
| `FAILED_MEDIA_RETENTION_DAYS` | `7` | Failed-media retention |
| `QUEUE_RECORD_RETENTION_DAYS` | `30` | Completed/failed queue-record retention after media cleanup |
| `CLEANUP_INTERVAL_MINUTES` | `60` | Retention cleanup frequency |

Use `-1` for a media or queue-record retention value to retain it indefinitely. Pending and retryable jobs are never removed by retention cleanup.

Queue records survive process and container restarts when the recordings directory is persisted. Jobs interrupted in `processing` return to `pending` on startup. A periodic stability scan recovers media written before a crash could create a queue job; active or recently modified stream directories are not processed.

## Security and Privacy

Webhook deliveries are verified against the exact raw body using Zoom's signature and timestamp headers. Valid normal events receive HTTP 200 before RTMS connection work begins.

Application logs contain queue job IDs and file names, not meeting UUIDs, RTMS stream IDs, webhook payloads, or transcript content. RTMSManager file and console logging is disabled in this sample because its connection diagnostics include those identifiers.

## Testing

```bash
npm test
npm audit --omit=dev
```

Tests cover per-stream file flushing, durable restart recovery, retries, stale-media recovery, stream-based upload bodies, multipart settings, and explicit encryption parameters.

## Docker

Build from the repository root:

```bash
docker build \
  -f storage/save_audio_and_video_to_aws_s3_storage_js/Dockerfile \
  -t rtms-s3-archive .

docker run --rm \
  --env-file storage/save_audio_and_video_to_aws_s3_storage_js/.env \
  -p 3000:3000 \
  -v rtms-s3-recordings:/workspace/rtms-samples/storage/save_audio_and_video_to_aws_s3_storage_js/recordings \
  rtms-s3-archive
```

The volume is required for durable queue and media recovery across container replacement. The image uses `npm ci` with the committed lockfile and includes FFmpeg `7:5.1.9-0+deb12u1`.

## Key Files

- `index.js`: RTMS lifecycle, webhook verification, recovery scheduling, and shutdown
- `MediaRecorder.js`: independent stream writers and reliable finalization
- `DurableUploadQueue.js`: persisted jobs, retries, restart recovery, and retention
- `MediaProcessingPipeline.js`: FFmpeg conversion and muxing
- `S3StorageHelper.js`: credential-chain S3 client and streaming multipart uploads
