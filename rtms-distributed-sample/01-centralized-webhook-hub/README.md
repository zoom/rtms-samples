# Centralized Webhook Hub

[Back to distributed sample overview](../README.md)

This is the public Zoom-facing entry point.

It receives RTMS webhooks, verifies Zoom signatures, rejects stale requests, suppresses duplicate RTMS retries, and hands accepted events to the route dispatcher.

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
| `ZOOM_SECRET_TOKEN` | Meeting/webinar webhook secret |
| `VIDEO_SECRET_TOKEN` | Video SDK webhook secret |
| `HUB_SQLITE_DB_PATH` | SQLite idempotency database |

## Related

- [Route dispatcher](../02-central-route-dispatcher/README.md)
- [Zoom signature helper](../shared/README.md)
- [Tests](../tests/README.md)
