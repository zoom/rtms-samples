# Regional Webhook Spoke

[Back to distributed sample overview](../README.md)

The regional spoke receives work already selected by the hub and dispatcher. It verifies the internal signature, writes regional state, and hands the event to local compute.

It should not decide which global region owns the stream. That decision belongs upstream.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Spoke config and state |
| `GET /local/events` | Local test/debug event list |
| `POST /spoke/webhook` | Signed internal webhook envelope |

## Run

```bash
SPOKE_REGION=IAD \
SPOKE_PORT=4200 \
INTERNAL_WEBHOOK_SECRET=internal-secret \
REGIONAL_STORE_URL=http://127.0.0.1:4101 \
COMPUTE_ENDPOINTS='["http://127.0.0.1:4710/compute/webhook"]' \
npm run start:spoke
```

For a distributed deployment, `REGIONAL_STORE_URL` and `COMPUTE_ENDPOINTS` should be full URLs reachable from this spoke. They can be FQDNs or private service DNS names, not only `host:port` pairs.

## Main Config

| Key | Purpose |
|-----|---------|
| `SPOKE_REGION` | Region label for this spoke |
| `SPOKE_PORT` | Local listen port, default `4200` |
| `REGIONAL_STORE_URL` | Regional control store URL |
| `COMPUTE_ENDPOINTS` | JSON array of compute launcher/worker URLs |
| `INTERNAL_WEBHOOK_SECRET` | Required HMAC secret |

## Related

- [Route dispatcher](../02-central-route-dispatcher/README.md)
- [Compute launcher](../04-regional-compute-launcher/README.md)
- [Control store](../05-control-store/README.md)
