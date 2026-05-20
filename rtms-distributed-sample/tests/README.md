# Test Helpers

[Back to distributed sample overview](../README.md)

These scripts send fake RTMS events through the sample without needing a real Zoom meeting.

The hub, route dispatcher, and control-store processes create local SQLite files under `.data` on startup.

## HTTP Webhook Sender

Start the local services in separate terminals:

```bash
npm run start:central-store
REGIONAL_STORE_PORT=4101 STORE_REGION=IAD npm run start:regional-store
SPOKE_REGION=IAD COMPUTE_PORT=4300 REGIONAL_STORE_URL=http://127.0.0.1:4101 CENTRAL_STORE_URL=http://127.0.0.1:4100 npm run start:compute
SPOKE_REGION=IAD SPOKE_PORT=4200 INTERNAL_WEBHOOK_SECRET=internal-secret REGIONAL_STORE_URL=http://127.0.0.1:4101 npm run start:spoke
INTERNAL_WEBHOOK_SECRET=internal-secret REGIONAL_SPOKE_ENDPOINTS='{"IAD":"http://127.0.0.1:4200/spoke/webhook","UNKNOWN":"http://127.0.0.1:4200/spoke/webhook"}' npm run start:dispatcher
npm run start:hub
```

Then send a signed start event followed by a signed stop event. The sender signs with `WEBHOOK_TEST_SECRET`, `ZOOM_SECRET_TOKEN`, or the local default `secret`:

```bash
npm run test:webhook -- --region IAD --send-stop
```

The stop event intentionally has no signaling URL. It tests that the local route lookup path can find the saved route by `rtms_stream_id`.

Webhook signature verification is required by default. Pass the same secret used by the hub:

```bash
ZOOM_SECRET_TOKEN=secret npm run start:hub
npm run test:webhook -- --region IAD --send-stop
```

Run the signature helper test:

```bash
npm run test:signature
```

Run the focused `01-centralized-webhook-hub` test against a running hub:

```bash
npm run test:01 -- --target http://127.0.0.1:4400/webhook --secret testsecrettoken
```

This checks health, URL validation, valid signature acceptance, duplicate RTMS webhook suppression, invalid signature rejection, stale timestamp rejection, and malformed payload rejection. It does not require RabbitMQ, the routing service, spokes, or compute workers.

Run the focused `02-central-route-dispatcher` route test against a running hub, dispatcher, and four spoke webhooks:

```bash
npm run test:02 -- --hub-url http://127.0.0.1:4400/webhook --secret testsecrettoken
```

This checks hub/dispatcher SQLite health, confirms dispatcher-to-spoke signing is enabled, then sends signed webhooks whose `payload.server_urls` contain RTMS codes and verifies they land on the expected spoke:

```text
SJC -> amer-west
IAD -> amer-east
FRA -> europe
NRT -> apac-hub
LHR -> us fallback
```

Run the focused `03-regional-webhook-spoke` security test against a running spoke:

```bash
npm run test:03 -- --spoke-url http://127.0.0.1:4611/spoke/webhook --events-url http://127.0.0.1:4611/local/events --secret testsecrettoken
```

This verifies the spoke rejects missing, invalid, and stale internal HMAC signatures, and accepts a correctly signed internal envelope.

Run the focused direct handoff integration test:

```bash
npm run test:04 -- --secret testsecrettoken
```

This starts temporary regional store, spoke, and dry-run compute processes on free local ports. It sends signed start/stop envelopes to the spoke and verifies the compute shim writes state through the regional SQLite control store. No SQLite queue is used.

Run the remote k3s/Kubernetes busybox launch test:

```bash
KUBECONFIG=/path/to/k3s-remote.yaml npm run test:05:k8s
```

This creates namespace `rtms` if needed, creates a per-Job Secret containing a dummy webhook envelope, submits a short `busybox:1.36` Job that reads `/var/run/rtms/envelope.json`, waits for completion, checks logs, then deletes the Job and Secret. Use `-- --keep` if you want to inspect them afterward.

Run the compute startup-from-store test:

```bash
npm run test:06
```

This saves the full start webhook envelope in the regional SQLite store, starts the compute wrapper with only `RTMS_STREAM_ID` and `RTMS_ENVELOPE_REF`, verifies the compute process loads the full webhook from the store, then saves a full stop webhook and verifies the compute process stops from the stored stop envelope.

Run the compute startup-from-mounted-file test:

```bash
npm run test:07
```

This writes a full webhook body to an envelope file, starts the compute wrapper with `RTMS_ENVELOPE_FILE`, and verifies the compute process loads the full webhook from that file before claiming the lease.

Run the artifact storage web service test:

```bash
npm run test:08
```

This starts `08-artifact-storage` with the local provider, uploads a Markdown artifact through JSON, uploads a raw byte artifact through `PUT`, verifies the object-key layout, checksum, size, and local file writes, then removes the test artifacts.

Run the mounted secret config test:

```bash
npm run test:09
```

This verifies the compute config helper can read Zoom credentials from normal env values, explicit `*_FILE` paths, and Kubernetes-style mounted Secret files under `RTMS_SECRET_DIR`.

Run the MinIO artifact storage test:

```bash
npm run test:10:minio
```

This reads `.env`, starts the local `object-storage` service from `compose.yaml` only when the MinIO endpoint is loopback, starts `08-artifact-storage` with the MinIO/S3-compatible provider, uploads a Markdown artifact, downloads it back through the S3 API, verifies the checksum/path layout, then deletes the temporary test bucket. Use `-- --no-compose` to skip Compose explicitly, or pass `-- --endpoint http://host:9000`.

Run the compute-to-artifact manifest test:

```bash
npm run test:11:compute-artifact
```

This starts a temporary regional store, local artifact service, and dry-run compute wrapper. On stop, compute uploads `manifest.json` through the artifact service and records the returned `blobUri` in the regional control store.

Run the realtime cache service test:

```bash
npm run test:12:realtime-cache
```

This starts `06-realtime-cache` in memory mode, writes stream state, summary, metrics, and events through the HTTP API, verifies the dashboard route, and checks the Prometheus `/metrics` output.

## Optional RabbitMQ Queue Smoke Test

The current sample path does not use SQLite as a queue and does not require RabbitMQ. The hub/dispatcher sends accepted webhook envelopes directly to the selected regional spoke by signed HTTP. Use this section only if you want to test RabbitMQ as a future swap-in for replay/backpressure.

Start RabbitMQ:

```bash
docker compose up -d rabbitmq
```

Start the webhook hub in optional RabbitMQ mode:

```bash
HUB_DELIVERY_MODE=rabbitmq npm run start:hub
```

Send one fake webhook through the hub, then read it from the ingress queue:

```bash
npm run test:webhook -- --region IAD
npm run test:queue:drain -- --queue rtms.webhooks.inbox
```

Publish one fake start envelope to the regional start queue:

```bash
npm run test:queue:publish -- --region IAD
```

Read one message back:

```bash
npm run test:queue:drain -- --queue rtms.start.region.iad
```

Start queues have a 60-second TTL. If no worker consumes the start message in time, RabbitMQ removes it from the active start queue and routes it to the warning queue:

```bash
npm run test:queue:drain -- --queue rtms.warning.start_expired
```

Use `--keep` if you want to inspect the message without removing it:

```bash
npm run test:queue:drain -- --queue rtms.start.region.iad --keep
```

## Optional Region Queue Generation

RabbitMQ queues are generated from a region list. For five deployed regions:

```bash
npm run rabbitmq:generate -- --regions IAD,SJC,AMS,FRA,SIN
```

The generator automatically adds `UNKNOWN` so unroutable events still have a safe queue.
