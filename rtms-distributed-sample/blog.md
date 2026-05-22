# Building a Simple Distributed Setup for Zoom RTMS

## Overview

Zoom Realtime Media Streams, or RTMS, lets a backend receive live meeting media from Zoom. Audio, video, transcript, chat, and screen share can all come through the stream.

For a small demo, one server is enough. Receive the webhook, connect to Zoom, save the media, done.

That works for testing.

But once the number grows, the single-server setup starts to show its limits. The box may be far away from some Zoom media servers. It also has only so much CPU, disk, and network bandwidth.

For this sample, I am using 10,000 concurrent meetings or sessions as the planning target. Not because one Docker setup can magically handle that. It is just a useful number to force the design to think bigger:

- send work to the nearest useful region
- keep active stream work close to Zoom
- keep small control data in SQLite
- keep large media files in object storage
- clean up compute after the stream stops

This is one way to build it. Not the only way. Another team may pick different regions, queues, databases, or cloud services. That is fine.

The important part is the shape.

Fan out the work to the right region. Fan it back in through storage, logs, cache, and cleanup.

That second half is where most of the real work is.

## The Routing Hint

When Zoom sends an RTMS start webhook, such as `meeting.rtms_started`, `webinar.rtms_started`, or `session.rtms_started`, the payload has a `server_urls` value.

Inside that URL, we can usually discover a region-like code:

```text
SJC, IAD, AMS, FRA, MEL, SYD, YYZ, SIN, NRT, HKG
```

That code is useful. It gives us a hint on where to run the stream worker.

If the Zoom URL has `IAD`, I would route it to compute near US East. If it has `SIN`, I would route it to an APAC group.

I would not treat this as a forever rule. Treat it as a starting point, then measure real timings.

You also don't need one region for every code. A practical first split is:

| Routing group | Zoom hints covered |
| --- | --- |
| `amer-west` | `SJC` |
| `amer-east` | `IAD`, `YYZ` |
| `europe` | `AMS`, `FRA` |
| `apac-hub` | `SIN`, `HKG`, `NRT`, `SYD`, `MEL` |

If you want to start even smaller:

| Routing group | Zoom hints covered |
| --- | --- |
| `americas` | `SJC`, `IAD`, `YYZ` |
| `europe` | `AMS`, `FRA` |
| `apac` | `SIN`, `HKG`, `NRT`, `SYD`, `MEL` |

I prefer the four-group version because US West and US East are far enough apart to matter. Later, APAC can also be split if the numbers say so.

Unknown codes should not break the system. Send them to a fallback, record them, then map them properly later.

## High Level Flow

The simple version looks like this:

```text
Zoom RTMS webhook
  -> Centralized Webhook Hub
  -> Central Route Dispatcher
  -> Route and accepted event saved centrally
  -> Selected Regional Spoke
  -> Local worker handoff
  -> Kubernetes / k3s Job
  -> RTMSManager
  -> Artifact Storage API
  -> MinIO / S3 / Azure / Google Cloud / local disk
  -> Realtime Cache
  -> Logs, metrics, dashboards
```

Another way to see it:

```text
Zoom
  |
  v
Centralized Webhook Hub
  | verify, dedupe, record webhook latency
  v
Central Route Dispatcher
  | choose one selected spoke
  v
Central Control Store
  | save route and accepted event
  v
Selected Regional Spoke
  | hand off to local worker
  v
Kubernetes Job
  | one pod for one stream attempt
  v
RTMSManager
  | connects to Zoom signaling and media, records signaling RTT
  v
Artifact Storage + Realtime Cache + Logs
```

The first part is fanout. The hub accepts the webhook, then the route dispatcher picks one region and sends the work there.

The second part is fanin. The stream produces logs, metrics, cache updates, audio files, video files, transcript files, and final manifests. Those all need to land somewhere predictable.

That is why the sample has more than just a webhook receiver.

## 1. Centralized Webhook Hub

The centralized webhook hub is the endpoint Zoom calls.

I would keep this in one public place first, probably the US for this sample. Its job should stay small:

- receive the Zoom webhook
- verify `x-zm-signature`
- reject old or replayed requests
- accept only the first copy of the same event
- pass the accepted event to the route dispatcher
- record webhook ingress latency for accepted RTMS webhooks

The stale timestamp check matters. Zoom signs the raw body together with `x-zm-request-timestamp`. If someone captures an old valid webhook and sends it again later, the signature may still match the old body. The hub should reject it if the timestamp is too old or too far in the future.

For accepted events, the hub can also measure how long the webhook took to reach you. In this sample, that is `webhook_ingress_latency_ms`: Zoom's signed timestamp compared with the hub receive time. This gives the dashboard a simple low, high, and average view of webhook delivery delay.

For start events, the route dispatcher looks at the Zoom URL and chooses a region.

For stop events, the route dispatcher should use the route it already saved for that `rtms_stream_id`. A stop event may not have the same region hint. Do not guess again.

One small detail matters here. If the route was saved as `amer-east`, treat it as the chosen group. Do not feed `amer-east` back into the airport-code mapper. That kind of double-mapping is how stop events end up in the wrong place.

The forwarded webhook body should stay the same. Add internal headers if needed, but don't reshape the Zoom payload before the regional spoke receives it.

Simple rule:

```text
No compute pod connects to Zoom unless it owns the stream.
```

## 2. Selected Regional Spoke

The regional spoke receives the accepted event from the route dispatcher.

It does not decide whether the event belongs there. The dispatcher already did that.

The spoke should:

- verify the internal call
- save small regional state
- hand the event to local compute
- make sure stop events reach the same region

The reason for this layer is distance. Keeping the handoff and compute near Zoom's media servers should help connection setup and first-packet timing.

The number of regions can change. Start with a few. Add more later. Remove the ones that do not help.

## 3. Direct Handoff First

For this version, I would keep the regional handoff direct.

Example:

```text
IAD stream
  -> dispatcher maps it to amer-east
  -> dispatcher forwards to amer-east spoke
  -> spoke starts one local worker
```

That worker can be a Docker process, a small Node process, or a Kubernetes-facing service that creates one Job per stream.

If it creates Kubernetes Jobs, the Job name should be predictable from `rtms_stream_id`. Retrying the same event should not create two active jobs.

If the direct path becomes too busy later, add a queue at this boundary. For now, I would not use SQLite as a queue. SQLite is for control data in this sample.

Start simple. Add moving parts only when the pressure is real.

## 4. Compute Job

The compute Job is where `RTMSManager` runs.

The model is:

```text
one RTMS stream attempt = one Kubernetes Job = one active pod
```

A meeting or Video SDK session can have a parent session key. The `rtms_stream_id` is the specific stream attempt.

The pod needs the accepted RTMS webhook to connect to Zoom. I would not pass the full webhook as one big environment variable. Store it in the regional control store, then pass small startup values:

```text
RTMS_STREAM_ID
RTMS_ENVELOPE_REF
REGION_CODE
REGIONAL_STORE_URL
```

The pod loads the full webhook before it connects.

If the Job runs in remote k3s or Kubernetes, remember this: `127.0.0.1` inside the pod means the pod itself. Not the webhook host. Use a LAN IP or an internal service name that the pod can actually reach.

If you really want to pass the webhook directly, mount it as a per-Job Kubernetes Secret file, for example:

```text
/var/run/rtms/envelope.json
```

Then pass only:

```text
RTMS_ENVELOPE_FILE=/var/run/rtms/envelope.json
```

That is cleaner than stuffing JSON into env vars.

Zoom credentials should be a separate Secret. The sample can read them from env, from `*_FILE` paths, or from mounted files under `RTMS_SECRET_DIR`.

Changing the host `.env` file is not enough for old pods. Sync the Kubernetes Secret, then recreate failed test Jobs if they were started with stale values.

For the first compute sizing pass, the sample requests `1` CPU and `4Gi` memory for each Job and caps it at `2` CPUs and `8Gi` memory. Keep those values in config and change them after measuring your media mix.

Before connecting to Zoom, the pod must claim the stream:

```text
rtms_stream_id
owner_pod_id
lease_version
lease_expires_at
```

Only one pod should own a stream attempt at a time. If the pod cannot renew the lease, it should close the RTMS connection.

This is what prevents two pods from connecting to the same Zoom stream.

It also helps when a pod or node dies. The lease expires. A new pod claims a higher `lease_version`. Old writes get rejected.

When `rtms_stopped` arrives, the pod should let `RTMSManager` close, finish the local recording work, upload final files, release the lease, and exit.

On `SIGTERM`, it should also call `RTMSManager.stop()`.

Cleanup sounds boring. It is not. Without cleanup, test clusters slowly fill with old Jobs, old Secrets, and old scratch files.

## 5. Fanin Is The Work

Fanout is the easy part to draw.

Fanin is the part that makes the system useful.

Once media starts flowing, the compute pod has to send things back:

- logs
- live counters
- current stream status
- transcript tails
- packet gap signals
- final audio files
- final video files
- manifests
- cleanup status

This is why the sample has a realtime cache, an artifact storage service, control stores, and logging.

The media worker should stay thin. It claims the stream, connects through `RTMSManager`, receives media events, saves what is needed, and reports status.

It should not become a database, object store, dashboard, and queue all in one process.

## 6. Central And Regional Control Data

For this sample, I split SQLite into two roles.

The central store sits near the public hub. It keeps:

- accepted event keys
- selected route
- stream status
- artifact pointers
- global lookup data

Each active region has its own regional store. It keeps:

- the full accepted webhook copy
- worker handoff state
- active lease owner
- pod heartbeat
- stop request state
- recovery state

This split keeps hot writes close to the compute pod. The central store still gives the hub and dashboards one place to ask:

```text
Which region owns this stream?
Where are the final files?
```

The lease should have one owner. If a stream is routed to `amer-east`, the `amer-east` regional store owns the active lease. The central store records the route and summary. It should not also hand out active RTMS leases for the same stream.

SQLite should not store raw audio or video. It is the notebook, not the warehouse.

## 7. Realtime Cache

A Redis-like cache is useful while meetings are active.

In the sample, the cache sits behind a small HTTP API. The compute pod can call simple endpoints for metrics, summaries, and events.

Good things to keep there:

- live summary snapshots
- transcript tails
- active streams by region
- pod health
- packet gap counters
- first-packet timing
- webhook ingress latency
- signaling ping RTT from the regional worker
- rolling webhook counts
- repeated issue counters

The webhook counts are simple but useful: total webhooks, accepted webhooks, unverified webhooks, and duplicate RTMS retries over the past minute, 60 minutes, and 24 hours. This gives operators a quick feel for whether traffic is normal, signatures are failing, or Zoom is retrying.

This can also power a live operations dashboard. If many calls suddenly mention the same issue or show the same error, the cache helps surface that quickly.

But the cache is not the source of truth.

If Redis disappears, the stream should keep running. Dashboards may become stale, but final state and final files should still land in the control store and object storage.

For media volume, the compute Job only counts bytes from the received RTMS media buffer and flushes the counters in batches. The dashboard displays that as MiB. This keeps the media path light and avoids turning monitoring into a second media pipeline.

For active streams, the useful number is not "how many stream records are cached." A stopped stream may stay in cache for inspection. The dashboard should count streams that are still in an active state.

## 8. Logs And Metrics

For local open-source tooling, Prometheus, Loki, OpenTelemetry Collector, and Grafana are a practical starting point.

`RTMSManager` already accepts a custom logger object. That makes it straightforward to send structured logs to Loki.

The sample also sends logs from the hub, dispatcher, spoke, compute launcher, control store, realtime cache, artifact storage service, compute Job, and lower-level RTMSManager code through the same logging path. Grafana reads those logs from Loki.

For metrics, I prefer to batch useful counters from compute into the realtime cache, then let Prometheus scrape that service.

Useful dashboard views:

- active streams by region
- regional spoke health
- active Job count
- stream state
- webhook verification and duplicate counts
- webhook ingress latency
- signaling ping RTT
- signaling and media connect timing
- first packet timing
- reconnect count
- lease failures
- final artifact status

Grafana should use friendly legend names where possible. A legend like `duplicate 60m` is easier to scan than a raw Prometheus label expression.

Nothing fancy first. Just enough to know what is alive, what is slow, and what failed.

## 9. Artifact Storage Service

The artifact storage service is a small backend web service.

The compute Job uploads final files to it:

- audio
- video
- transcript
- summary
- manifest

The service writes the bytes to local disk, MinIO, AWS S3, Azure Blob Storage, or Google Cloud Storage. Then it returns a pointer, object key, checksum, size, and content type.

The control store keeps that pointer.

The control store should not become the media bucket.

For a local sample, MinIO is useful because it gives an S3-like API in Docker. The same artifact service can write to MinIO during testing and to S3 later by changing config.

In the sample, the compute wrapper writes a `manifest.json` on stop. It can also upload final audio and video files through the same API.

Raw chunks stay temporary. Final files are what we keep.

## Timing Matters

RTMS recovery timing affects lease timing.

If the lease lasts too long, a dead pod can block the replacement pod. By the time the replacement starts, Zoom may already have stopped waiting.

A reasonable starting point:

```text
LEASE_TTL_MS=45000
LEASE_RENEW_INTERVAL_MS=15000
```

Not magic numbers. Just a safer starting point than waiting longer than the reconnect window you have measured and documented for the RTMS path you run.

## Storage Shape

The storage rule is simple:

```text
Central store: route, accepted event, global lookup, final file pointers
Regional store: full webhook copy, active lease, active state
Redis-like cache: fast live state
Artifact API: one upload endpoint
Object storage: large final files
```

Large final files should go into object storage.

For users, keep object storage focused on final combined files:

- `.wav`
- `.mp4`
- transcript files
- summary files
- `manifest.json`

For object paths, use something stable:

```text
rtms/v1/date=2026-05-18/hour_utc=08/region=iad/zoom_product=meeting/artifact_type=summary_final/shard=af/stream_id=abc123/final.md
```

This `key=value` style is friendly to many data tools later.

For reconnects or takeovers, don't assume one numeric meeting ID equals one artifact group. Use a parent session key for the real meeting or session, then keep each `rtms_stream_id` as a child attempt.

That makes cleanup and searching much easier later.

## Swappable Services

The exact tools are not the point.

In this sample I am using:

```text
Direct HTTP: spoke to worker handoff
RabbitMQ: optional queue experiment
SQLite: sample control data
Redis-like cache: live state
Artifact storage service: one upload API
Prometheus, Loki, Grafana: monitoring
Kubernetes: one Job per stream attempt
```

If you prefer SQS, Service Bus, Pub/Sub, Kafka, Postgres, another cache, or another dashboard stack, that is fine.

Just keep the responsibilities clear:

- one place accepts the webhook
- one route is chosen
- one worker owns the stream
- live state is disposable
- final files go to object storage
- old compute gets cleaned up

## Reliability

The biggest risk is simple:

```text
two pods connect to the same RTMS stream
```

Avoid that first.

The main controls:

- verify Zoom webhooks before routing
- sign internal dispatcher-to-spoke delivery
- accept the same event only once
- use transactions or conditional updates for leases
- reject stale writers with `leaseVersion`
- keep the lease below the RTMS reconnect window
- alert on failed handoffs
- monitor lease failures and startup timing

For production, direct HTTP handoff should be measured carefully. From Zoom's point of view, the public webhook can reply quickly. Inside your system, direct handoff is simpler. A queue can be added later if replay becomes important.

## Where I Expect Pressure

At 10,000 concurrent meetings or sessions, I don't expect the first pain to be the route table.

The pressure is more likely around the workers:

- many WebSocket connections
- lots of packet handling
- media conversion
- local scratch files
- upload timing
- downstream transcript or AI calls

Use SSD or NVMe-backed machines. Slow disks will hurt when queue files, SQLite WAL files, Redis AOF, and temporary media files all start writing at the same time.

Keep raw media out of SQLite. Once raw media enters the database, it stops being a control store and becomes an expensive media bucket.

## Security Should Be Boring

The webhook endpoint should fail closed.

Every Zoom webhook should be verified from the raw body and timestamp:

```text
v0:{x-zm-request-timestamp}:{raw request body}
```

Compare that expected value against `x-zm-signature`.

Keep supporting services private and password protected:

- control-store APIs
- Redis
- RabbitMQ
- Grafana
- object storage

Production secrets should live in Kubernetes Secrets or a cloud secret manager. Not in frontend code. Not in checked-in `.env` files.

Object paths should also avoid user names, meeting topics, and anything sensitive. Keep those fields in the control store with access control.

Let the blob path stay boring.

## Try It

Start small.

Run the hub, one regional spoke, one regional store, and one compute Job.

Send a dummy RTMS start webhook. Make sure exactly one compute container claims the stream.

Then send the stop webhook. Confirm the Job exits cleanly.

After that, add:

- remote k3s Job launcher
- artifact storage service
- realtime cache
- dashboards

Check the practical things first:

- JSON env values stay quoted
- the pod can reach the regional store
- the compute Secret has current RTMS credentials
- stop events return to the same selected spoke
- the one-stream Job disappears after stop
- final audio/video files upload correctly

Then measure the timings that matter:

- webhook ingress latency
- webhook to spoke
- Job startup
- lease claim
- signaling ping RTT and connect time
- media connect
- first packet
- final file upload

The design is only useful if those numbers look good in your own environment.

## References

- Zoom RTMS docs: https://developers.zoom.us/docs/rtms/
- Zoom RTMS JavaScript SDK reference: https://zoom.github.io/rtms/js/
- Zoom webhook verification: https://developers.zoom.us/docs/api/webhooks/#verify-webhook-events
- Designing Data-Intensive Applications by Martin Kleppmann: https://dataintensive.net/
- AWS Well-Architected Framework: https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
