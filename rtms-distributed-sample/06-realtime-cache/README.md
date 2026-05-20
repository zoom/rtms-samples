# Realtime Cache Service

This layer is a small HTTP API in front of a Redis-like cache. `RTMSManager` code can call it during a live stream without knowing whether the backing cache is Redis, Valkey, a managed Redis service, or in-memory mode for tests.

It is for active-meeting views only:

- live summary snapshots
- transcript tails
- participant snapshots
- active stream state by region
- node health snapshots
- latency, reconnect, media-byte, and media-gap counters
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

curl -X POST http://127.0.0.1:4560/streams/stream-123/summary \
  -H 'content-type: application/json' \
  -d '{"text":"Customer is asking about a billing issue","userName":"Alice"}'

curl http://127.0.0.1:4560/streams/stream-123
```

The compute job uses `REALTIME_CACHE_URL` to send state, events, and aggregated media metrics. It buffers media counters and flushes them every few seconds so it does not make an HTTP call for every media packet.

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
REALTIME_CACHE_TTL_SECONDS=7200
REALTIME_CACHE_MAX_EVENTS=100
```

Prometheus can scrape `/metrics`; Grafana can read Prometheus for active stream counts and metric sums.
