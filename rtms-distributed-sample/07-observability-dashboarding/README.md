# Observability, Logging, And Dashboarding

[Back to distributed sample overview](../README.md)

This optional layer uses the open-source Grafana observability stack.

Recommended stack:

- OpenTelemetry Collector for metrics/logs/traces ingestion.
- Prometheus for metrics.
- Loki for logs.
- Grafana for dashboards.
- Tempo can be added later for traces if request-path tracing becomes important.

Product/report read sources:

- Postgres for durable stream state, route, lease, node, artifact, and meeting metadata.
- Blob storage for final artifacts through signed URLs or backend proxy.
- Realtime cache for active-meeting summaries and low-latency monitoring.

This layer should be read-only for ownership and orchestration. It must not claim streams, renew leases, or connect to Zoom RTMS.

Log retention:

- Loki is configured for two-week retention with `retention_period: 336h`.
- RTMSManager file logs are hourly files and do not self-delete. Prefer stdout to Loki, or use logrotate/sidecar cleanup if file logging is enabled.

Initial dashboard ideas:

- Active streams by region.
- Node capacity and active stream count.
- Stream lifecycle state.
- RTMS signaling/media latency.
- First packet latency.
- Reconnect and interruption count.
- Lease failures and takeover events.
- Artifact completion status.
- Live meeting summary during active meetings.

Local endpoints:

```text
Grafana:    http://127.0.0.1:3001
Prometheus: http://127.0.0.1:9090
Loki:       http://127.0.0.1:3100
OTLP HTTP:  http://127.0.0.1:4318
OTLP gRPC:  127.0.0.1:4317
```

The default Grafana local login comes from `compose.yaml` fallback values unless overridden in `.env`. Change it before exposing Grafana outside local development.

## RTMSManager Fit

`RTMSManager` is already close to plug-and-play for logging. The library accepts a custom `logger` object during `RTMSManager.init()`, and its internal code calls `debug`, `info`, `log`, `warn`, and `error` on that object.

This sample now passes `shared/rtmsObservabilityLogger.js` from the compute job. It writes structured JSON to stdout and can push the same entries directly to Loki when `LOKI_PUSH_URL` is set:

```text
LOKI_PUSH_URL=http://loki:3100/loki/api/v1/push
RTMS_LOG_LEVEL=info
RTMS_LOG_CONSOLE=true
```

Grafana does not receive logs directly. Grafana reads Loki for logs and Prometheus for metrics.

For metrics, the first sample path is:

```text
RTMSManager events -> compute job aggregation -> realtime cache API -> /metrics -> Prometheus -> Grafana
```

That keeps high-frequency media packets from turning into one network call per packet. The compute job batches counters such as audio bytes, video bytes, stream state changes, and session state changes before sending them to the realtime cache service.
