# Central Route Dispatcher

[Back to distributed sample overview](../README.md)

This local shim receives accepted webhooks from the hub, persists the selected route, signs the internal handoff, and forwards the event to one regional spoke.

Start events choose a spoke from the RTMS signaling URL hint. Stop and interrupted events have no routing hint, so the dispatcher uses the saved `rtms_stream_id` route. A fresh accepted start for an already-routed stream also stays with the saved spoke so recovery does not create a competing regional owner.

RabbitMQ files in this folder are optional. The default sample path is signed HTTP handoff.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Dispatcher and SQLite health |
| `POST /orchestrate/webhook` | Accepted webhook envelope from the hub |

## Run

```bash
INTERNAL_WEBHOOK_SECRET=internal-secret \
SPOKE_AMER_EAST_URL=https://rtms-spoke-amer-east.internal/spoke/webhook \
SPOKE_UNKNOWN_URL=https://rtms-spoke-amer-east.internal/spoke/webhook \
npm run start:dispatcher
```

## Optional Queue Topology

Generate RabbitMQ definitions when testing a queue-based handoff:

```bash
npm run rabbitmq:generate -- --regions IAD,SJC,AMS,FRA,SIN
docker compose up -d rabbitmq
```

Use RabbitMQ mode only when testing replay/backpressure behavior:

```bash
HUB_DELIVERY_MODE=rabbitmq npm run start:hub
```

## Main Config

| Key | Purpose |
|-----|---------|
| `CENTRAL_ROUTE_DISPATCHER_PORT` | HTTP port, default `4050` |
| `ROUTER_SQLITE_DB_PATH` | Route/idempotency SQLite path |
| `SPOKE_AMER_WEST_URL`, `SPOKE_AMER_EAST_URL`, `SPOKE_EUROPE_URL`, `SPOKE_APAC_HUB_URL` | Full spoke URLs for the common spoke groups |
| `SPOKE_UNKNOWN_URL` | Fallback spoke URL when the Zoom RTMS code is unknown |
| `REGIONAL_SPOKE_ENDPOINTS` | Optional JSON map from route code/group to spoke URL |
| `INTERNAL_WEBHOOK_SECRET` | HMAC secret for dispatcher-to-spoke calls |
| `RABBITMQ_URL` | Optional RabbitMQ URL |

Use full service URLs. Local tests often use `http://127.0.0.1:4611/...`, but real deployments can use FQDNs or private service discovery names such as `https://rtms-spoke-amer-east.internal/spoke/webhook`.

## Related

- [Webhook hub](../01-centralized-webhook-hub/README.md)
- [Regional spoke](../03-regional-webhook-spoke/README.md)
- [Shared region helpers](../shared/README.md)
