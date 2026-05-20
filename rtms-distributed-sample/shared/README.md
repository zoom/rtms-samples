# Shared Helpers

[Back to distributed sample overview](../README.md)

This folder contains small helpers used by the sample services.

| File | Purpose |
|------|---------|
| [`artifactClient.js`](./artifactClient.js) | Client for `08-artifact-storage` uploads |
| [`artifactStorage.js`](./artifactStorage.js) | Local, MinIO/S3, Azure Blob, and GCS storage providers |
| [`envelope.js`](./envelope.js) | Normalized internal event envelope |
| [`errors.js`](./errors.js) | Retryable error classification |
| [`http.js`](./http.js) | JSON HTTP helpers and fire-and-forget calls |
| [`idempotency.js`](./idempotency.js) | Stable webhook idempotency key builder |
| [`internalSignature.js`](./internalSignature.js) | HMAC signing for internal service calls |
| [`kubernetesJobLauncher.js`](./kubernetesJobLauncher.js) | Kubernetes Job and Secret creation |
| [`postgresRetry.js`](./postgresRetry.js) | Retry helper for future Postgres swaps |
| [`rabbitmq.js`](./rabbitmq.js) | Optional RabbitMQ confirm-publish helpers |
| [`realtimeCacheClient.js`](./realtimeCacheClient.js) | Client for realtime cache state/metrics |
| [`regions.js`](./regions.js) | RTMS event and region routing helpers |
| [`retry.js`](./retry.js) | Full-jitter retry helper |
| [`rtmsObservabilityLogger.js`](./rtmsObservabilityLogger.js) | Structured logger for compute/RTMSManager |
| [`secretConfig.js`](./secretConfig.js) | Env, `*_FILE`, and mounted Secret credential loading |
| [`sqliteRoutingStore.js`](./sqliteRoutingStore.js) | Hub/dispatcher SQLite route and idempotency store |
| [`zoomSignature.js`](./zoomSignature.js) | Zoom webhook signature and URL validation helpers |

## Related

- [Webhook hub](../01-centralized-webhook-hub/README.md)
- [Compute launcher](../04-regional-compute-launcher/README.md)
- [Compute job](../04-regional-compute-job/README.md)
