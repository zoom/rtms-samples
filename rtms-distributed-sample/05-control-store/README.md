# Control Store

[Back to distributed sample overview](../README.md)

The control store is the durable lookup layer for this sample. It uses SQLite locally and keeps the contract simple enough to swap later.

Use it for routes, stream state, leases, documents, artifact metadata, and the small accepted or recovery envelopes that let a regional worker start or reconnect. Do not store raw media bytes here.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Store role and SQLite health |
| `GET /streams` | List streams |
| `GET /streams/:streamId` | Stream lookup |
| `PUT /streams/:streamId/route` | Save selected route |
| `POST /streams/:streamId/claim` | Claim active lease |
| `POST /streams/:streamId/lease-renew` | Renew lease |
| `POST /streams/:streamId/release` | Release lease |
| `POST /streams/:streamId/state` | Append/update state |
| `POST /streams/:streamId/events` | Append event |
| `POST /streams/:streamId/documents` | Save document metadata/content |
| `POST /streams/:streamId/blobs` | Save artifact/blob metadata |

The central role keeps selected routes and global lookup state. The regional role keeps the full accepted start envelope, lease state, stop state, and recovery envelopes for the compute Job that owns the stream.

## Run

Central store:

```bash
npm run start:central-store
```

Regional store:

```bash
REGIONAL_STORE_PORT=4101 STORE_REGION=IAD npm run start:regional-store
```

## Main Config

| Key | Purpose |
|-----|---------|
| `STORE_ROLE` | `central` or `regional` |
| `STORE_REGION` | Region label for regional stores |
| `CENTRAL_PORT` | HTTP port |
| `CONTROL_DATA_DIR` | Base data folder |
| `CONTROL_SQLITE_DB_PATH` | Explicit SQLite path |

## Related

- [Regional spoke](../03-regional-webhook-spoke/README.md)
- [Compute job lease flow](../04-regional-compute-job/README.md)
- [Artifact storage metadata](../08-artifact-storage/README.md)
