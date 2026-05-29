# Centralized Webhook Hub

[Back to distributed sample overview](../README.md)

This is the public Zoom-facing entry point.

It receives RTMS webhooks, verifies Zoom signatures, rejects stale requests, suppresses duplicate RTMS retries, and hands accepted events to the route dispatcher. The accepted RTMS set includes start, stop, and interrupted lifecycle events; route selection stays out of this service.

For accepted RTMS webhooks, it also sends `webhook_ingress_latency_ms` to the realtime cache. That value is calculated from Zoom's signed `x-zm-request-timestamp` against the hub's current receive time. Duplicate retries, unsigned requests, stale requests, and `rtms.concurrency_limited` observations are counted separately from accepted stream latency.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Service and SQLite health |
| `POST $WEBHOOK_PATH` | Zoom RTMS webhook receiver, default `/webhook` |

## Run

```bash
npm run start:hub
```

For signed local webhook tests:

```bash
ZOOM_SECRET_TOKEN=secret npm run start:hub
npm run test:webhook -- --region IAD --send-stop
```

## Main Config

| Key | Purpose |
|-----|---------|
| `HUB_PORT` | HTTP port, default `4000` |
| `WEBHOOK_PATH` | Webhook path, default `/webhook` |
| `HUB_DELIVERY_MODE` | `http` by default; `rabbitmq` is optional |
| `CENTRAL_ROUTE_DISPATCHER_URL` | Dispatcher target for accepted webhooks |
| `REALTIME_CACHE_URL` | Optional realtime cache target for webhook latency samples |
| `LOKI_PUSH_URL` | Optional Loki push endpoint for structured service logs |
| `ZOOM_SECRET_TOKEN` | Meeting/webinar webhook secret |
| `VIDEO_SECRET_TOKEN` | Video SDK webhook secret |
| `HUB_SQLITE_DB_PATH` | SQLite idempotency database |

## Related

- [Route dispatcher](../02-central-route-dispatcher/README.md)
- [Zoom signature helper](../shared/README.md)
- [Tests](../tests/README.md)
