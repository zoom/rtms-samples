# Central Route Dispatcher

[Back to distributed sample overview](../README.md)

This local shim receives accepted webhooks from the hub, persists the selected route, signs the internal handoff, and forwards the event to one regional spoke.

RabbitMQ files in this folder are optional. The default sample path is signed HTTP handoff.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Dispatcher and SQLite health |
| `POST /orchestrate/webhook` | Accepted webhook envelope from the hub |

## Run

```bash
INTERNAL_WEBHOOK_SECRET=internal-secret \
REGIONAL_SPOKE_ENDPOINTS='{"IAD":"http://127.0.0.1:4200/spoke/webhook","UNKNOWN":"http://127.0.0.1:4200/spoke/webhook"}' \
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
| `REGIONAL_SPOKE_ENDPOINTS` | JSON map from route code to spoke URL |
| `INTERNAL_WEBHOOK_SECRET` | HMAC secret for dispatcher-to-spoke calls |
| `RABBITMQ_URL` | Optional RabbitMQ URL |

## Related

- [Webhook hub](../01-centralized-webhook-hub/README.md)
- [Regional spoke](../03-regional-webhook-spoke/README.md)
- [Shared region helpers](../shared/README.md)
