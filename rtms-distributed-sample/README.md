# RTMS Distributed Sample

This sample shows one practical way to run Zoom RTMS across regions without putting every responsibility into one server.

The short version:

- the public hub receives Zoom RTMS webhooks
- the hub chooses one regional spoke
- the spoke starts one worker for the stream
- the worker runs `RTMSManager`
- final audio/video/manifest files go through the artifact storage API
- live state goes to the realtime cache
- logs and metrics go to the observability layer

This is still a sample, not a production blueprint. The important shape is fanout to the right region, then fanin through storage, cache, logs, and cleanup.

## Architecture Diagram

```mermaid
flowchart TD
  Zoom[Zoom RTMS webhook] --> Hub[01 centralized webhook hub<br/>verify, dedupe, route]
  Hub --> Central[(central SQLite<br/>accepted event, route, global lookup)]
  Central --> Spoke[03 selected regional webhook spoke]
  Spoke --> Launcher[04 regional compute launcher]
  Launcher --> Job[Kubernetes/k3s Job<br/>one pod per stream]
  Job --> Regional[(regional SQLite<br/>lease and active state)]
  Job --> Manager[RTMSManager<br/>Zoom signaling and media]
  Job --> Artifact[08 artifact storage API]
  Artifact --> Blob[(local disk / MinIO / S3 / Azure / GCS)]
  Job --> Cache[06 realtime cache<br/>hot state and metrics]
  Job --> Obs[07 logs, metrics, dashboards]
  Hub -. stop events use saved route .-> Central
```

## Flow

```text
Zoom RTMS webhook
  -> 01 centralized webhook hub
  -> central route/control state
  -> selected 03 regional webhook spoke
  -> 04 regional compute launcher
  -> Kubernetes Job, one pod per stream
  -> 04 regional compute job / RTMSManager
  -> 08 artifact storage for final files
  -> 06 realtime cache for active state
  -> 07 observability for logs and dashboards
```

For `rtms_started`, the hub reads the Zoom signaling URL hint and maps it to a spoke group such as `amer-east`, `amer-west`, `europe`, or `apac-hub`.

For `rtms_stopped`, the hub uses the saved route for the `rtms_stream_id`. Stop events should go back to the same selected region.

## Folder Guide

| Folder | Purpose | Details |
|--------|---------|---------|
| [`01-centralized-webhook-hub/`](./01-centralized-webhook-hub/) | Public Zoom webhook receiver | [README](./01-centralized-webhook-hub/README.md) |
| [`02-central-route-dispatcher/`](./02-central-route-dispatcher/) | Local route dispatcher and optional RabbitMQ topology | [README](./02-central-route-dispatcher/README.md) |
| [`03-regional-webhook-spoke/`](./03-regional-webhook-spoke/) | Selected regional spoke | [README](./03-regional-webhook-spoke/README.md) |
| [`04-regional-compute-launcher/`](./04-regional-compute-launcher/) | Creates one Kubernetes Job per stream | [README](./04-regional-compute-launcher/README.md) |
| [`04-regional-compute-job/`](./04-regional-compute-job/) | Runs `RTMSManager`, records media, uploads final artifacts | [README](./04-regional-compute-job/README.md) |
| [`05-control-store/`](./05-control-store/) | SQLite control state, routes, leases, artifacts, documents | [README](./05-control-store/README.md) |
| [`06-realtime-cache/`](./06-realtime-cache/) | Live stream state and Prometheus metrics | [README](./06-realtime-cache/README.md) |
| [`07-observability-dashboarding/`](./07-observability-dashboarding/) | Grafana, Loki, Prometheus, OpenTelemetry configs | [README](./07-observability-dashboarding/README.md) |
| [`08-artifact-storage/`](./08-artifact-storage/) | One upload API for local disk, MinIO/S3, Azure, or GCS | [README](./08-artifact-storage/README.md) |
| [`shared/`](./shared/) | Shared helpers for signatures, HTTP, storage, retries, secrets | [README](./shared/README.md) |
| [`tests/`](./tests/) | Local integration and smoke tests | [README](./tests/README.md) |

## Quick Start

Install dependencies:

```bash
npm install
```

Create local config:

```bash
cp .env.example .env
```

Start local infrastructure:

```bash
docker compose up -d realtime-cache object-storage prometheus loki otel-collector grafana
```

Start the core Node services in separate terminals:

```bash
npm run start:central-store
REGIONAL_STORE_PORT=4101 STORE_REGION=IAD npm run start:regional-store
npm run start:artifact-storage
npm run start:realtime-cache
INTERNAL_WEBHOOK_SECRET=internal-secret npm run start:dispatcher
SPOKE_REGION=IAD INTERNAL_WEBHOOK_SECRET=internal-secret npm run start:spoke
npm run start:hub
```

For local tests, use the test helpers:

```bash
npm run check
npm run test:04 -- --secret testsecrettoken
npm run test:08
npm run test:12:realtime-cache
```

For the full test list, see [`tests/README.md`](./tests/README.md).

## Filling `.env`

`.env.example` has the same active key list as the live deployment `.env`, but with safe placeholder values.

Fill these groups first:

| Group | Keys |
|-------|------|
| Zoom webhook verification | `ZOOM_SECRET_TOKEN`, `VIDEO_SECRET_TOKEN` |
| RTMS credentials | `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `VIDEO_CLIENT_ID`, `VIDEO_CLIENT_SECRET` |
| Kubernetes launcher | `KUBECONFIG`, `KUBECONFIG_INLINE_B64`, `K8S_COMPUTE_IMAGE`, `K8S_NAMESPACE` |
| Artifact storage | `ARTIFACT_STORAGE_PROVIDER`, `ARTIFACT_BUCKET`, `ARTIFACT_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Realtime cache | `REDIS_PASSWORD`, `REALTIME_CACHE_REDIS_URL`, `REALTIME_CACHE_REDIS_PASSWORD` |
| Media request | `MEDIA_TYPES_FLAG`, `AUDIO_STREAM_MODE`, `VIDEO_STREAM_MODE` |

`MEDIA_TYPES_FLAG=32` requests all available RTMS media. Use `3` for audio + video or `9` for audio + transcript.

For Kubernetes Jobs, changing the host `.env` is not enough. Update the Kubernetes Secret and recreate old failed Jobs so new pods receive current credentials.

## Media And Artifacts

The compute job does not upload directly to MinIO or S3. It writes temporary media to pod scratch disk, finalizes files with the common media helpers, then uploads final outputs through [`08-artifact-storage`](./08-artifact-storage/README.md).

Expected final uploads include:

- `manifest.json`
- final `.wav` audio when audio is received
- final `.mp4` video when video is received
- transcript, summary, or other text artifacts when added by the app

Raw chunks stay temporary and should not be treated as user-facing artifacts.

## Reliability Notes

Keep these rules in mind while changing the sample:

- verify Zoom webhook signatures before routing
- accept a repeated RTMS webhook only once
- route stop events by saved `rtms_stream_id`
- let only one pod own a stream lease
- keep lease TTL below the RTMS reconnect window
- keep realtime cache disposable
- put large final files in object storage, not SQLite
- keep `blog.md`, `.env`, recordings, `.data`, and `node_modules` out of git

## Useful Links

- [Test helpers](./tests/README.md)
- [Compute job media recording](./04-regional-compute-job/README.md)
- [Artifact storage API](./08-artifact-storage/README.md)
- [Realtime cache API](./06-realtime-cache/README.md)
- [Observability stack](./07-observability-dashboarding/README.md)
