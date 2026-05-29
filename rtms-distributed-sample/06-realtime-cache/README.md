# Realtime Cache Service

[Back to distributed sample overview](../README.md)

This layer is a small HTTP API in front of a Redis-like cache. `RTMSManager` code can call it during a live stream without knowing whether the backing cache is Redis, Valkey, a managed Redis service, or in-memory mode for tests.

It is for active-meeting views only:

- live summary snapshots
- transcript tails
- participant snapshots
- active stream state by region
- node health snapshots
- latency, reconnect, media-byte, and media-gap counters
- lowest, highest, and average latency for selected measurements
- dashboard data for current calls

It is not the source of truth after the meeting. Durable state belongs in the control store, and media bytes belong in artifact storage.

## Run

Memory mode:

```bash
REALTIME_CACHE_BACKEND=memory npm run start:realtime-cache
```

Redis mode using the local Docker Redis service:

```bash
docker compose up -d realtime-cache
REALTIME_CACHE_BACKEND=redis \
REALTIME_CACHE_REDIS_URL=redis://127.0.0.1:6379 \
REALTIME_CACHE_REDIS_PASSWORD="$REDIS_PASSWORD" \
npm run start:realtime-cache
```

Default service URLs:

```text
API:       http://127.0.0.1:4560
Dashboard: http://127.0.0.1:4560/dashboard
Metrics:   http://127.0.0.1:4560/metrics
```

## API

```bash
curl -X POST http://127.0.0.1:4560/streams/stream-123/state \
  -H 'content-type: application/json' \
  -d '{"state":"connected","regionCode":"amer-east","nodeId":"iad-node-1"}'

curl -X POST http://127.0.0.1:4560/streams/stream-123/metrics \
  -H 'content-type: application/json' \
  -d '{"metrics":{"audio_bytes_total":4096,"video_bytes_total":8192}}'

curl -X POST http://127.0.0.1:4560/streams/stream-123/latency \
  -H 'content-type: application/json' \
  -d '{"name":"webhook_ingress_latency_ms","valueMs":120,"source":"centralized-webhook-hub","regionCode":"amer-east"}'

curl -X POST http://127.0.0.1:4560/streams/stream-123/summary \
  -H 'content-type: application/json' \
  -d '{"text":"Customer is asking about a billing issue","userName":"Alice"}'

curl http://127.0.0.1:4560/streams/stream-123
```

The hub uses `REALTIME_CACHE_URL` to send accepted webhook ingress latency and rolling webhook counters, including `rtms.concurrency_limited` observations. The compute job uses `REALTIME_CACHE_URL` to send state, events, signaling ping RTT, and aggregated media metrics. It buffers media counters and flushes them every few seconds so it does not make an HTTP call for every media packet.

Current latency keys:

| Metric | Meaning |
|--------|---------|
| `webhook_ingress_latency_ms` | Zoom signed webhook timestamp to hub receive time |
| `signaling_ping_rtt_ms` | Regional RTMSManager worker to Zoom signaling WebSocket ping RTT |

Suggested keys stay readable:

```text
rtms:stream:{streamId}
rtms:index:streams
rtms:index:regions
rtms:region:{regionCode}:streams
rtms:node:{nodeId}:health
```

Use TTLs aggressively so stale live state disappears after node failures:

```text
REALTIME_CACHE_TTL_SECONDS=300
REALTIME_CACHE_STREAM_FRESHNESS_SECONDS=180
REALTIME_CACHE_MAX_EVENTS=100
```

`GET /streams` returns fresh/live streams only. Use `GET /streams?include=all` when debugging the raw cache contents.

Prometheus can scrape `/metrics`; Grafana can read Prometheus for active stream counts, metric sums, and latency min/max/average gauges.
