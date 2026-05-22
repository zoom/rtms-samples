# RTMS Distributed Sample TODO

Working notes for the distributed RTMS sample. The committed README is the public setup and architecture guide. This file is for the remaining design checks, logic risks, and implementation backlog.

## Current Design Rules

- Keep this sample on the local `main` branch unless there is a specific reason to branch.
- Keep all distributed-sample work under `/var/www/rtms-sample.asdc.cc/rtms-samples/rtms-distributed-sample`.
- Do not reintroduce the old sibling runtime directory `/var/www/rtms-sample.asdc.cc/rtms-distributed-sample`.
- Do not add `ecosystem.js`; PM2 process names are part of the local test harness only.
- The local PM2/Docker runtime is only a single-box test harness. Real deployment should split hub, dispatcher, regional spokes, regional launchers, control stores, cache, observability, object storage, and Kubernetes compute onto the correct central or regional systems.
- Treat `.env`, `.data`, recordings, `node_modules`, package lock churn, and generated media as local runtime files.

## Flow To Preserve

```text
Zoom webhook
  -> 01 centralized webhook hub
     - verify Zoom signature and timestamp
     - reject unverified or stale events
     - drop duplicate RTMS retry attempts for about 65 minutes
  -> 02 route dispatcher
     - choose selected spoke for start events
     - route stop events by saved rtms_stream_id
     - route interrupted events and active-stream refresh starts by saved rtms_stream_id
  -> 03 selected regional webhook spoke
     - verify internal handoff signature
     - persist regional handoff state
     - call local regional compute launcher
  -> 04 regional compute launcher
     - create one Kubernetes Job per rtms_stream_id
     - mount the full envelope as a per-job Secret
  -> 04 regional compute job
     - load the envelope
     - claim the stream lease
     - start RTMSManager
     - observe owner-directed recovery envelopes during lease renewal
     - write live state, logs, metrics, and final artifacts
```

## Logic Risks To Tighten First

1. **Hub direct handoff is at-most-once today.**
   The hub returns `204` to Zoom before the dispatcher/spoke handoff has completed. That is good for fast webhook response, but it means a dispatcher outage after the `204` can lose the accepted start event. Add a durable hub outbox so idempotency, route intent, and dispatch intent commit together before acknowledging Zoom.

2. **Stop delivery depends on regional store visibility.**
   A running compute Job receives stop by observing `stop_requested` during lease renewal. The launcher deletion timer is cleanup, not the primary stop signal. Keep `LEASE_RENEW_INTERVAL_MS` comfortably below 60 seconds, keep `K8S_STOP_JOB_DELETE_DELAY_MS` longer than one renew interval, and add a check that the Job observed stop before forced deletion.

3. **Internal auth is incomplete past the spoke.**
   Dispatcher-to-spoke is signed. Spoke-to-launcher currently relies on private reachability. Add HMAC verification or equivalent service identity to the launcher endpoint before treating it as production-safe.

4. **Lease fencing should protect every owner write.**
   Claim and renew use owner/lease checks, but release and final state/artifact writes should also include `leaseVersion` where practical. This avoids stale owners overwriting state after a takeover.

5. **Kubernetes termination needs a stronger finish path.**
   SIGTERM currently stops RTMSManager and flushes telemetry. Add a bounded shutdown path that marks the stream interrupted, flushes realtime metrics/logs, releases the lease when allowed, and uploads any final manifest/artifact metadata that can be safely completed within the termination grace period.

6. **Idempotency can hide failed dispatch without an outbox.**
   Because repeated RTMS webhook attempts are dropped for about 65 minutes, retries from Zoom will not repair a hub-accepted event that failed later in internal delivery. This is another reason the hub needs a persisted dispatch status, retry loop, and alert.

7. **Regional store write failures must not create split behavior.**
   For start, the spoke should not launch compute if regional state cannot be written. For stop, failing to write `stop_requested` should raise a high-priority alert because the launcher may otherwise delete the Job before the worker has gracefully stopped.

## Next Implementation Steps

1. Add a hub outbox table and publisher for direct selected-spoke delivery.
2. Track outbox status: pending, dispatching, delivered, retrying, failed, dead-lettered.
3. Add operator-visible alerts for accepted-but-not-dispatched events, start events older than 60 seconds, stop events with no saved route, failed regional handoff, and Kubernetes launch failures.
4. Add launcher request signing and verification for spoke-to-launcher calls.
5. Add explicit SQLite schema versioning/migrations for hub, dispatcher, and control-store databases.
6. Add integration tests for stop routing without region code, regional store stop visibility, Kubernetes Job launch/delete, per-job Secret cleanup, artifact metadata lookup, and artifact upload failure handling.
7. Add a bounded SIGTERM finalization test for the compute Job.
8. Expand Grafana dashboards for handoff latency, launch latency, active Jobs, stop latency, lease failures, artifact completion, blob upload failures, and RTMS signaling RTT by selected region.

## Operational Metrics To Add

- webhook accepted-to-dispatch latency
- dispatcher-to-spoke handoff latency
- spoke-to-launcher handoff latency
- Kubernetes Job creation latency
- Job start-to-RTMS-connect latency
- first media packet latency
- signaling ping RTT by selected region
- lease claim failures and renew failures
- stop requested-to-observed latency
- stop requested-to-Job-deleted latency
- artifact finalize/upload latency and failures
- outbox retry count and dead-letter count
- local scratch disk usage and free space

## Production Readiness Checks

- Measure real RTMS signaling/media latency before finalizing the four selected spoke groups.
- Load test per-node stream limits separately for audio-only, transcript-only, audio+video, screen share, and all-media workloads.
- Validate the per-stream Kubernetes request and limit defaults against measured stream resource use before scaling the cluster.
- Keep object storage as the durable place for final media artifacts; keep SQLite/control-store rows as metadata and lookup state only.
- Keep the realtime cache disposable; do not make Redis the system of record.
- Define retention for logs, realtime cache entries, control-store rows, transcripts, summaries, final media, and debug artifacts.
- Define tenant/customer authorization boundaries for dashboards, control-store views, artifact lookup, and blob access.
- Redact PII from logs, metrics, object keys, dashboards, and error responses.
- Use SSD-backed disks for local scratch, SQLite WAL files, Redis persistence, Prometheus/Loki data, and any local object-storage testing.

## Optional Later Layers

- Add RabbitMQ or a managed regional queue only when replay, backpressure, delayed retries, or regional outage buffering is needed.
- Add production manifests or Helm/Kustomize for each service after the sample shape stabilizes.
- Add a distributed or managed control store only when central/regional SQLite no longer meets latency, availability, or operations needs.
- Add regional dashboard rollups after the basic central dashboard is reliable.
