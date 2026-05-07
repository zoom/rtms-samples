# Production Deployment Guide

This guide covers distributed architecture patterns for deploying RTMS applications at scale.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              INGRESS LAYER                                          │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                    Load Balancer (nginx / ALB / CloudFlare)                 │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                       │                                             │
│                    ┌──────────────────┴──────────────────┐                          │
│                    ▼                                      ▼                         │
│           ┌──────────────┐                       ┌──────────────┐                   │
│           │ Master Node  │                       │ Master Node  │  (HA pair)        │
│           │  (Primary)   │◄─────────────────────►│  (Standby)   │                   │
│           └──────┬───────┘                       └──────────────┘                   │
└──────────────────┼──────────────────────────────────────────────────────────────────┘
                   │
                   │  Webhook: meeting.rtms_started / meeting.rtms_stopped
                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              COORDINATION LAYER                                     │
│                                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐                  │
│  │      Redis      │    │   Message Queue │    │   Config Store  │                  │
│  │  - Meeting Map  │    │  (RabbitMQ/SQS) │    │  (Consul/etcd)  │                  │
│  │  - Worker State │    │  - Start Jobs   │    │  - Credentials  │                  │
│  │  - Heartbeats   │    │  - Stop Jobs    │    │  - Feature Flags│                  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘                  │
│                                                                                     │
└──────────────────┬──────────────────────────────────────────────────────────────────┘
                   │
                   │  Job Assignment
                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              WORKER LAYER                                           │
│                                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │  Worker 1   │  │  Worker 2   │  │  Worker 3   │  │  Worker N   │                 │
│  │             │  │             │  │             │  │             │                 │
│  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │                 │
│  │ │Meeting A│ │  │ │Meeting C│ │  │ │Meeting E│ │  │ │Meeting G│ │                 │
│  │ │Meeting B│ │  │ │Meeting D│ │  │ │Meeting F│ │  │ │   ...   │ │                 │
│  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │                 │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │
│         │                │                │                │                        │
│         └────────────────┴────────────────┴────────────────┘                        │
│                                   │                                                 │
└───────────────────────────────────┼─────────────────────────────────────────────────┘
                                    │
                                    │  WebSocket to Zoom
                                    ▼
                    ┌───────────────────────────────┐
                    │      Zoom RTMS Servers        │
                    │  (Signaling + Media per mtg)  │
                    └───────────────────────────────┘
                                    │
                                    │  Media Streams
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              FAN-OUT LAYER                                          │
│                                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   Audio     │  │   Video     │  │ Transcript  │  │   Chat      │                 │
│  │  Pipeline   │  │  Pipeline   │  │  Pipeline   │  │  Pipeline   │                 │
│  │             │  │             │  │             │  │             │                 │
│  │ - Zoom      │  │ - S3 Store  │  │ - OpenAI    │  │ - Slack     │                 │
│  │ - Assembly  │  │ - Rekognit. │  │ - Claude    │  │ - Webhook   │                 │
│  │ - Whisper   │  │ - Kinesis   │  │ - DB Store  │  │ - Archive   │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘                 │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              OBSERVABILITY LAYER                                    │
│                                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐                  │
│  │   Centralized   │    │    Metrics      │    │    Alerting     │                  │
│  │     Logging     │    │   (Prometheus)  │    │  (PagerDuty)    │                  │
│  │  (ELK / Loki)   │    │                 │    │                 │                  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘                  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Master Node

The master node is the entry point for all Zoom webhooks. It does NOT handle media streams directly.

**Responsibilities:**
- Receive `meeting.rtms_started` and `meeting.rtms_stopped` webhooks (or `webinar.rtms_started` and `session.rtms_started`)
- Validate webhook signatures
- Select appropriate worker (based on capacity, affinity, or round-robin)
- Publish job to message queue
- Store meeting-to-worker mapping in Redis
- Handle webhook deduplication (same event may arrive twice)

**High Availability:**
- Run 2+ master nodes behind load balancer
- Stateless design—all state in Redis/Queue
- Health checks for automatic failover

### Worker Node

Workers handle the actual RTMS connections and media processing.

**Responsibilities:**
- Subscribe to job queue for start/stop commands
- Establish WebSocket connections to Zoom signaling/media servers
- Process incoming media streams
- Fan out media to downstream pipelines
- Report heartbeat and capacity to Redis
- Handle graceful shutdown (drain meetings)

**Capacity Planning:**
- Each worker can handle N concurrent meetings (depends on CPU/memory/bandwidth)
- Track active meeting count per worker
- Reject jobs if at capacity (master will retry on another worker)

### Redis (State Store)

Central state for coordination:

```
meetings:{meeting_uuid} -> {
  worker_id: "worker-2",
  stream_id: "...",
  started_at: 1234567890,
  media_types: ["audio", "video", "transcript"]
}

workers:{worker_id} -> {
  capacity: 50,
  active_meetings: 23,
  last_heartbeat: 1234567890,
  status: "healthy"
}
```

### Message Queue

Decouples master from workers:

- **Start Queue**: Master publishes, workers consume
- **Stop Queue**: Master publishes, routed to specific worker
- Enables retry logic, dead-letter handling
- Provides backpressure when workers are overloaded

## Meeting Lifecycle

### Start Flow

```
1. Zoom sends webhook: meeting.rtms_started
                │
                ▼
2. Master validates signature, dedupes
                │
                ▼
3. Master queries Redis for worker capacity
                │
                ▼
4. Master selects worker with lowest load
                │
                ▼
5. Master publishes to start queue:
   { meeting_uuid, stream_id, server_urls, assigned_worker }
                │
                ▼
6. Master stores mapping in Redis:
   meetings:{uuid} -> worker-3
                │
                ▼
7. Worker-3 receives job from queue
                │
                ▼
8. Worker-3 connects to signaling WebSocket
                │
                ▼
9. Worker-3 connects to media WebSocket
                │
                ▼
10. Worker-3 starts receiving media, fans out to pipelines
```

### Stop Flow

```
1. Zoom sends webhook: meeting.rtms_stopped
                │
                ▼
2. Master looks up worker in Redis:
   meetings:{uuid} -> worker-3
                │
                ▼
3. Master publishes to stop queue:
   { meeting_uuid, target_worker: "worker-3" }
                │
                ▼
4. Worker-3 receives stop command
                │
                ▼
5. Worker-3 closes WebSocket connections
                │
                ▼
6. Worker-3 flushes any buffered media
                │
                ▼
7. Worker-3 removes from local state
                │
                ▼
8. Master deletes from Redis:
   DEL meetings:{uuid}
```

## Worker Health & Failure Recovery

### Heartbeat System

Workers send heartbeats to Redis every 5 seconds:

```
SETEX workers:{worker_id}:heartbeat 15 {timestamp}
```

Master (or separate monitor) checks for stale heartbeats:

```
If now - last_heartbeat > 15s:
  - Mark worker as unhealthy
  - Reassign its meetings to other workers
```

### Worker Failure Recovery

When a worker dies unexpectedly:

1. **Detection**: Heartbeat expires (15s timeout)
2. **Discovery**: Query Redis for all meetings assigned to dead worker
3. **Reassignment**: For each meeting:
   - Check if meeting is still active (call Zoom API or wait for next webhook)
   - Assign to healthy worker
   - New worker reconnects to signaling/media servers
4. **Cleanup**: Remove dead worker from Redis

### Reconnection Time Limits (Critical)

RTMS has strict reconnection windows. If you miss these, you must re-initiate RTMS via the API:

| Connection | Reconnect Window | If Missed |
|------------|------------------|-----------|
| **Media WebSocket** | **30 seconds** | Must re-initiate RTMS |
| **Signaling WebSocket** | **60 seconds** | Must re-initiate RTMS |

**Recovery timeline:**

```
Worker dies at T=0
        │
        ▼
T+15s: Heartbeat expires, failure detected
        │
        ▼
T+15s-20s: New worker assigned, begins reconnecting
        │
        ├──► Media WebSocket: Must connect by T+30s (10-15s remaining)
        │
        └──► Signaling WebSocket: Must connect by T+60s (40-45s remaining)
```

**If reconnection window missed:**

```
1. Call Zoom API to stop RTMS for this meeting
   POST /meetings/{meetingId}/rtms/stop

2. Call Zoom API to start RTMS again
   POST /meetings/{meetingId}/rtms/start

3. Wait for new meeting.rtms_started webhook

4. Connect with new stream_id and server_urls
```

**Best practices for fast recovery:**
- Keep heartbeat interval short (5s) for fast detection
- Pre-warm worker connections (keep WebSocket libraries loaded)
- Use regional workers to minimize connection latency
- Have recovery worker pool ready (not at 100% capacity)

### Graceful Shutdown
### Graceful Shutdown

For deployments and scaling down:

```
1. Worker receives SIGTERM
                │
                ▼
2. Worker stops accepting new jobs
                │
                ▼
3. Worker notifies master: "draining"
                │
                ▼
4. Worker waits for active meetings to end
   (or timeout after 5 minutes)
                │
                ▼
5. Worker force-closes remaining connections
                │
                ▼
6. Worker exits
```

## Fan-Out Architecture (Optional)

Fan-out is **optional** and depends on your use case. Simple applications may process media directly on the worker or send to a single destination. Complex applications may route different media types to different systems.

### Simple: Direct Processing

```
Worker receives media packet
        │
        └──► Process directly on worker
              - Store to S3
              - Send to single transcription service
              - Write to database
```

### Advanced: Multi-Destination Fan-Out

For applications that need to route media to multiple destinations:

```
Worker receives media packet
        │
        ├──► Audio Pipeline (async)
        │     ├── Buffer 100ms chunks
        │     ├── Send to Zoom Scribe
        │     └── Store transcript in DB
        │
        ├──► Video Pipeline (async)
        │     ├── Extract keyframes
        │     ├── Send to S3
        │     └── Send to Rekognition
        │
        ├──► Transcript Pipeline (async)
        │     ├── Aggregate sentences
        │     ├── Send to LLM for summarization
        │     └── Broadcast to frontend
        │
        └──► Chat Pipeline (async)
              ├── Forward to Slack
              └── Archive to DB
```

**When to use fan-out:**
- Multiple consumers need the same media
- Different processing requirements per media type
- Isolation between downstream systems
- Independent scaling per pipeline

**When NOT to use fan-out:**
- Single destination (just send directly)
- Simple storage-only use case
- Low volume, no scaling needs

**Backpressure Handling:**
- Use bounded queues for each pipeline
- If queue full: drop oldest (live streaming) or block (recording)
- Alert on sustained queue depth
## Centralized Logging

All nodes ship logs to central aggregator:

```
{
  "timestamp": "2025-01-23T10:30:00Z",
  "level": "info",
  "service": "rtms-worker",
  "worker_id": "worker-3",
  "meeting_uuid": "abc123",
  "stream_id": "xyz789",
  "event": "media_received",
  "media_type": "audio",
  "bytes": 3200,
  "user_id": 12345,
  "user_name": "John Doe"
}
```

**Log Levels:**
- `debug`: Individual packets, detailed state
- `info`: Connection events, meeting lifecycle
- `warn`: Reconnections, timeouts, retries
- `error`: Failures, exceptions

**Correlation:**
- Use `meeting_uuid` to trace across all components
- Include `request_id` from webhook for end-to-end tracing

## Metrics & Monitoring

### Key Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `rtms_active_meetings` | Gauge | Meetings currently being processed |
| `rtms_worker_capacity` | Gauge | Available slots per worker |
| `rtms_media_bytes_total` | Counter | Total bytes received by type |
| `rtms_connection_errors` | Counter | WebSocket connection failures |
| `rtms_pipeline_queue_depth` | Gauge | Pending items in fan-out queues |
| `rtms_meeting_duration_seconds` | Histogram | Meeting session durations |
| `rtms_webhook_latency_ms` | Histogram | Time from webhook to job published |

### Alerting Rules

| Condition | Severity | Action |
|-----------|----------|--------|
| Worker heartbeat missing > 30s | Critical | Page on-call |
| All workers at > 90% capacity | Warning | Scale up workers |
| Pipeline queue depth > 1000 | Warning | Check downstream |
| Connection error rate > 5% | Critical | Check Zoom status |
| Meeting start latency > 5s | Warning | Check queue depth |

## Scaling Strategies

### Horizontal Scaling

- **Workers**: Add more workers when average capacity > 70%
- **Pipelines**: Each pipeline can scale independently
- **Redis**: Use Redis Cluster for large deployments

### Auto-Scaling Triggers

```
IF avg(worker_capacity_used) > 70% for 5m:
  scale_up(workers, +2)

IF avg(worker_capacity_used) < 30% for 15m:
  scale_down(workers, -1)  # graceful drain
```

### Capacity Estimation

| Resource | Per Meeting |
|----------|-------------|
| CPU | ~0.1 core (audio only), ~0.5 core (audio+video) |
| Memory | ~50MB (buffers, state) |
| Bandwidth | ~100 Kbps (audio), ~2 Mbps (video HD) |

Example: 8-core, 16GB worker can handle ~50 audio-only or ~15 audio+video meetings.

## Security Considerations

### Credentials Management

- Store Zoom credentials in secret manager (Vault, AWS Secrets Manager)
- Workers fetch credentials on startup, cache in memory
- Rotate credentials without restart (watch for changes)

### Network Security

- Workers only need outbound WebSocket to Zoom
- Internal communication over private network
- TLS everywhere

### Data Handling

- Media streams may contain sensitive content
- Encrypt at rest if storing
- Implement retention policies
- Log access for audit

## Deployment Checklist

- [ ] Redis cluster deployed with persistence
- [ ] Message queue deployed with dead-letter handling
- [ ] Master nodes behind load balancer with health checks
- [ ] Worker nodes with auto-scaling group
- [ ] Centralized logging configured
- [ ] Metrics and dashboards set up
- [ ] Alerting rules configured
- [ ] Graceful shutdown tested
- [ ] Worker failure recovery tested
- [ ] Credential rotation process documented

## Performance & Resource Limits

### The Golden Rule: Separate I/O from Processing

**Critical Design Decision**: Workers should primarily handle I/O (receiving WebSocket data, forwarding to queues). Heavy processing (transcoding, ML inference, compression) should happen on separate processing nodes or external services.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        WORKER NODE (I/O Focused)                        │
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│  │  WebSocket  │    │  WebSocket  │    │  WebSocket  │                 │
│  │  Meeting A  │    │  Meeting B  │    │  Meeting C  │   ... x N       │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                 │
│         │                  │                  │                         │
│         └──────────────────┼──────────────────┘                         │
│                            │                                            │
│                            ▼                                            │
│                   ┌─────────────────┐                                   │
│                   │  Event Loop     │  ◄── Keep this FAST              │
│                   │  (Single Thread)│      No blocking operations!      │
│                   └────────┬────────┘                                   │
│                            │                                            │
│              ┌─────────────┼─────────────┐                              │
│              ▼             ▼             ▼                              │
│         ┌────────┐    ┌────────┐    ┌────────┐                         │
│         │ Queue  │    │ Queue  │    │ Queue  │   Async publish only    │
│         │(Audio) │    │(Video) │    │(Trans) │   No processing here    │
│         └────────┘    └────────┘    └────────┘                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    PROCESSING NODES (CPU Focused)                       │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ Audio Processor │  │ Video Processor │  │  ML Inference   │         │
│  │                 │  │                 │  │                 │         │
│  │ - FFmpeg        │  │ - Transcoding   │  │ - Whisper       │         │
│  │ - Resampling    │  │ - Keyframe ext. │  │ - Rekognition   │         │
│  │ - Normalization │  │ - Thumbnails    │  │ - Custom models │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why This Matters

If you do heavy processing on the worker node:

1. **Event loop blocks** → WebSocket read buffers fill up → Zoom disconnects
2. **CPU queue grows** → Latency spikes → Real-time processing fails
3. **Memory pressure** → GC pauses → More latency
4. **One bad meeting affects all** → Noisy neighbor problem

### Resource Bottlenecks & Limits

#### CPU

| Scenario | CPU per Meeting | Max Meetings (8-core) |
|----------|-----------------|----------------------|
| Receive + forward only | 0.02 cores | 400 |
| Light processing (base64 decode) | 0.05 cores | 160 |
| Medium processing (audio resampling) | 0.2 cores | 40 |
| Heavy processing (FFmpeg transcode) | 1.0+ cores | 8 |
| ML inference (Whisper, etc.) | 2.0+ cores | 4 |

**Recommendation**: Keep worker CPU usage < 0.1 cores per meeting. Offload anything heavier.

#### CPU Queue / Run Queue

Monitor CPU run queue length:
```bash
# Linux: check run queue
uptime  # load average
cat /proc/loadavg  # first number = run queue

# Target: run queue < number of cores
# Warning: run queue > 2x cores = severe contention
```

| Run Queue State | Impact |
|-----------------|--------|
| < cores | Healthy, tasks run immediately |
| = cores | At capacity, slight delays |
| 2x cores | Contention, noticeable latency |
| 4x cores | Severe, WebSocket timeouts likely |

**Alert when**: `load_average_1m > (num_cores * 1.5)` for 2 minutes

#### Memory

| Component | Memory per Meeting |
|-----------|-------------------|
| WebSocket buffers (2 connections) | 64 KB |
| Application state | 10 KB |
| Audio ring buffer (1 second) | 32 KB |
| Video frame buffer (3 frames) | 6 MB (720p) / 24 MB (1080p) |
| Processing overhead | 10-50 MB |

**Conservative estimate**: 50-100 MB per meeting (audio+video)

| Worker Memory | Max Meetings |
|---------------|--------------|
| 4 GB | 40 |
| 8 GB | 80 |
| 16 GB | 160 |

**Recommendation**: Leave 20% memory headroom for GC and spikes.

#### Bandwidth

| Media Type | Bitrate | Per Meeting (in + out) |
|------------|---------|------------------------|
| Audio (16kHz mono) | 256 Kbps | 512 Kbps |
| Audio (48kHz stereo) | 1.5 Mbps | 3 Mbps |
| Video (720p) | 2-4 Mbps | 4-8 Mbps |
| Video (1080p) | 4-8 Mbps | 8-16 Mbps |
| Transcript | 1 Kbps | 2 Kbps |

**Network calculation**:
```
1 Gbps link = 1000 Mbps
Per meeting (audio+video 720p) = ~8 Mbps bidirectional
Max meetings = 1000 / 8 = 125 meetings

With 50% headroom = 60 meetings per 1 Gbps link
```

**Recommendation**: Use 10 Gbps for production, monitor at 60% utilization.

#### File Descriptors / Sockets

Each meeting requires:
- 2 WebSocket connections (signaling + media)
- Queue connections (Redis, RabbitMQ)
- Downstream connections (S3, APIs)

```bash
# Check current limits
ulimit -n  # default often 1024, need higher

# Set higher limit
ulimit -n 65535

# Or in /etc/security/limits.conf
* soft nofile 65535
* hard nofile 65535
```

| Meetings | File Descriptors Needed |
|----------|------------------------|
| 100 | ~500 |
| 500 | ~2,500 |
| 1000 | ~5,000 |

#### Disk I/O (if writing locally)

| Operation | IOPS per Meeting |
|-----------|------------------|
| Logging | 1-5 |
| Audio write (chunked) | 10-50 |
| Video write (chunked) | 50-200 |
| Buffering/temp files | 10-100 |

**SSD recommended**: Minimum 3000 IOPS for 50+ meetings

**Recommendation**: Avoid local disk writes on workers. Stream directly to object storage or queues.

### Concurrent WebSocket Limits

**Per-process limits** (Node.js / Python):

| Language/Runtime | Max WebSockets | Notes |
|------------------|----------------|-------|
| Node.js (single thread) | 10,000+ | Event loop is the bottleneck |
| Python (asyncio) | 5,000+ | GIL can be limiting |
| Go | 100,000+ | Goroutines scale well |
| Java (Netty) | 50,000+ | Thread pool tuning needed |

**Practical limit** is usually hit by:
1. CPU for processing
2. Memory for buffers
3. Bandwidth for data transfer

**Not** the WebSocket connection count itself.

### Worker Sizing Recommendations

#### Small (Dev/Test)
- 2 cores, 4 GB RAM, 1 Gbps
- Max: 20 audio-only or 10 audio+video meetings
- Use case: Development, demos

#### Medium (Production Start)
- 4 cores, 8 GB RAM, 1 Gbps
- Max: 50 audio-only or 25 audio+video meetings
- Use case: Small-scale production

#### Large (Production Scale)
- 8 cores, 16 GB RAM, 10 Gbps
- Max: 100 audio-only or 50 audio+video meetings
- Use case: High-volume production

#### XLarge (High Density)
- 16 cores, 32 GB RAM, 25 Gbps
- Max: 200 audio-only or 100 audio+video meetings
- Use case: Maximum density per node

### Performance Monitoring Checklist

```
□ CPU usage per core (not just average)
□ CPU run queue / load average
□ Memory usage + GC frequency
□ Network throughput in/out
□ WebSocket connection count
□ Event loop lag (Node.js) / asyncio lag (Python)
□ Queue depths (internal buffers)
□ File descriptor usage
□ Disk I/O wait (if applicable)
```

### Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| FFmpeg on worker | Blocks event loop | Separate transcoding service |
| Synchronous HTTP calls | Blocks processing | Use async/await everywhere |
| Large in-memory buffers | Memory pressure | Stream to queue/storage |
| Logging to disk | I/O blocks | Log to stdout, ship async |
| ML inference on worker | CPU starves I/O | Separate ML service |
| Single worker for everything | No isolation | Separate by meeting type |
| No backpressure | Unbounded queues | Bounded queues + drop policy |


### Memory Buffering vs Direct Disk Writes

When storing media (recordings, transcripts), you have two strategies:

#### Strategy 1: Direct Disk Writes (Chatty I/O)

```
Media packet arrives
        │
        ▼
Write to disk immediately
        │
        ▼
Repeat for every packet (100+ writes/second)
```

**Pros:**
- Data is persisted immediately
- No data loss on crash
- Simple implementation

**Cons:**
- High IOPS usage (100-500 writes/sec per meeting)
- Disk becomes bottleneck
- SSD wear increases
- Limits concurrent meetings

#### Strategy 2: Memory Buffer + Periodic Flush

```
Media packet arrives
        │
        ▼
Append to in-memory buffer
        │
        ▼
When buffer full OR timer fires (e.g., every 5 seconds)
        │
        ▼
Flush entire buffer to disk in single write
```

**Pros:**
- Much lower IOPS (1 write per flush interval)
- Better disk utilization
- Higher throughput
- More concurrent meetings

**Cons:**
- **Risk of data loss** if process crashes before flush
- Higher memory usage
- More complex implementation

#### Trade-off Matrix

| Approach | IOPS | Data Loss Risk | Memory | Best For |
|----------|------|----------------|--------|----------|
| Direct writes | High | None | Low | Critical recordings |
| 1s buffer | Medium | 1 second | Medium | Balanced |
| 5s buffer | Low | 5 seconds | Medium | High throughput |
| 30s buffer | Very Low | 30 seconds | High | Maximum efficiency |
| Memory only (no disk) | Zero | All on crash | High | Streaming/forwarding |

#### Hybrid Approach: Write-Ahead Log

For critical data with high throughput:

```
Media packet arrives
        │
        ├──► Append to memory buffer (fast path)
        │
        └──► Append to write-ahead log (sequential writes only)
                │
                ▼
        On flush: write buffer to final destination
                │
                ▼
        On recovery: replay WAL to recover unflushed data
```

**Implementation tips:**
- WAL uses sequential writes (fast, even on HDD)
- Final storage can be batched/optimized
- Recovery replays WAL on startup
- Truncate WAL after confirmed flush

#### Recommendations by Use Case

| Use Case | Strategy | Buffer Size |
|----------|----------|-------------|
| Live transcription | Memory only | N/A (forward immediately) |
| Live streaming | Memory only | N/A (forward immediately) |
| Recording (best effort) | 5-10s buffer | 5-10 MB |
| Recording (critical) | WAL + buffer | 1s WAL, 5s buffer |
| Compliance/legal | Direct writes | N/A |

## Geo-Routing & Regional Affinity

### Understanding RTMS Server URLs

The `meeting.rtms_started` webhook payload contains a `server_urls` field with the signaling server URL. The URL hostname contains a **3-letter airport code (IATA)** indicating the Zoom data center location:

```
wss://rwcpdns{N}.zoom.us/{path}
         ^^^
         Contains region identifier (e.g., SJC, IAD, SIN)
```

**Example hostnames:**
- `...sjc...zoom.us` → San Jose, California (US West)
- `...iad...zoom.us` → Washington D.C. area (US East)
- `...sin...zoom.us` → Singapore (APAC)
- `...fra...zoom.us` → Frankfurt (Europe)

### Zoom Data Center Locations

| Code | City | Region | Suggested Worker Location |
|------|------|--------|---------------------------|
| `SJC` | San Jose | US West (N. California) | AWS us-west-1 / GCP us-west1 |
| `IAD` | Washington D.C. | US East (N. Virginia) | AWS us-east-1 / GCP us-east4 |
| `AMS` | Amsterdam | Europe (Netherlands) | AWS eu-west-1 / GCP europe-west1 |
| `FRA` | Frankfurt | Europe (Germany) | AWS eu-central-1 / GCP europe-west1 |
| `MEL` | Melbourne | Asia Pacific (Australia) | AWS ap-southeast-2 / GCP australia-southeast1 |
| `SYD` | Sydney | Asia Pacific (Australia) | AWS ap-southeast-2 / GCP australia-southeast1 |
| `YYZ` | Toronto | Canada (Central) | AWS ca-central-1 / GCP northamerica-northeast1 |
| `SIN` | Singapore | Asia Pacific (Singapore) | AWS ap-southeast-1 / GCP asia-southeast1 |
| `NRT` | Tokyo | Asia Pacific (Japan) | AWS ap-northeast-1 / GCP asia-northeast1 |
| `HKG` | Hong Kong | Asia Pacific (Hong Kong) | AWS ap-east-1 / GCP asia-east2 |

### Why Geo-Routing Matters

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BAD: High Latency Path                          │
│                                                                         │
│  Zoom RTMS (Singapore)  ──────────────────────►  Worker (US East)       │
│                              ~200ms RTT                                 │
│                              Packet loss risk                           │
│                              Jitter increases                           │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         GOOD: Low Latency Path                          │
│                                                                         │
│  Zoom RTMS (Singapore)  ──────►  Worker (Singapore)                     │
│                           ~5ms RTT                                      │
│                           Reliable connection                           │
│                           Minimal jitter                                │
└─────────────────────────────────────────────────────────────────────────┘
```

**Impact of high latency:**
- WebSocket keep-alive may timeout
- Audio/video sync issues
- Reconnection storms during network blips
- Higher packet loss probability
- Increased buffering requirements

### Extracting Region from Server URL

Parse the airport code from the hostname:

```javascript
const REGION_MAP = {
  'SJC': 'US West (N. California)',
  'IAD': 'US East (N. Virginia)',
  'AMS': 'Europe (Amsterdam)',
  'FRA': 'Europe (Frankfurt)',
  'MEL': 'Asia Pacific (Melbourne)',
  'SYD': 'Asia Pacific (Sydney)',
  'YYZ': 'Canada (Central)',
  'SIN': 'Asia Pacific (Singapore)',
  'NRT': 'Asia Pacific (Tokyo)',
  'HKG': 'Asia Pacific (Hong Kong)'
};

function extractRegion(serverUrl) {
  const hostname = new URL(serverUrl).hostname.toUpperCase();
  
  for (const [code, name] of Object.entries(REGION_MAP)) {
    if (hostname.includes(code)) {
      return { code, name };
    }
  }
  
  return { code: 'UNKNOWN', name: 'Unknown Location' };
}

// Example:
// "wss://rwcpdns123sjc.zoom.us/..." → { code: 'SJC', name: 'US West (N. California)' }
// "wss://rwcpdns456sin.zoom.us/..." → { code: 'SIN', name: 'Asia Pacific (Singapore)' }
```

### Regional Worker Deployment

Deploy workers in regions that match Zoom's data center locations:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         GLOBAL ARCHITECTURE                             │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  US Region   │    │  EU Region   │    │ APAC Region  │              │
│  │              │    │              │    │              │              │
│  │ ┌──────────┐ │    │ ┌──────────┐ │    │ ┌──────────┐ │              │
│  │ │Worker    │ │    │ │Worker    │ │    │ │Worker    │ │              │
│  │ │ SJC/IAD  │ │    │ │ AMS/FRA  │ │    │ │ SIN/NRT  │ │              │
│  │ └────┬─────┘ │    │ └────┬─────┘ │    │ └────┬─────┘ │              │
│  └──────┼───────┘    └──────┼───────┘    └──────┼───────┘              │
│         │                   │                   │                       │
│         └───────────────────┼───────────────────┘                       │
│                             │                                           │
│                    ┌────────▼────────┐                                  │
│                    │  Global Master  │                                  │
│                    │  (Routes by     │                                  │
│                    │   region code)  │                                  │
│                    └─────────────────┘                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Region-to-Worker Mapping

Configure master node with region affinity rules:

```javascript
const regionMapping = {
  // Americas
  'SJC': ['worker-us-west-1a', 'worker-us-west-1b'],
  'IAD': ['worker-us-east-1a', 'worker-us-east-1b'],
  'YYZ': ['worker-ca-central-1a', 'worker-us-east-1a'],  // fallback to US
  
  // Europe
  'AMS': ['worker-eu-west-1a', 'worker-eu-central-1a'],
  'FRA': ['worker-eu-central-1a', 'worker-eu-west-1a'],
  
  // Asia Pacific
  'SIN': ['worker-ap-southeast-1a', 'worker-ap-southeast-1b'],
  'NRT': ['worker-ap-northeast-1a', 'worker-ap-southeast-1a'],
  'HKG': ['worker-ap-east-1a', 'worker-ap-southeast-1a'],
  'SYD': ['worker-ap-southeast-2a', 'worker-ap-southeast-1a'],
  'MEL': ['worker-ap-southeast-2a', 'worker-ap-southeast-1a'],
  
  // Fallback
  'UNKNOWN': ['worker-us-east-1a', 'worker-eu-central-1a', 'worker-ap-southeast-1a'],
};

function selectWorker(serverUrl, workerCapacities) {
  const { code } = extractRegion(serverUrl);
  const preferredWorkers = regionMapping[code] || regionMapping['UNKNOWN'];
  
  // Select worker with lowest load from preferred region
  for (const workerId of preferredWorkers) {
    const capacity = workerCapacities[workerId];
    if (capacity && capacity.available > 0) {
      return workerId;
    }
  }
  
  // All preferred workers full - fall back to any available
  return selectAnyAvailableWorker(workerCapacities);
}
```

### Latency Monitoring by Region

Track connection quality per region:

| Metric | Description |
|--------|-------------|
| `rtms_connection_latency_ms{region}` | WebSocket handshake time |
| `rtms_keepalive_rtt_ms{region}` | Keep-alive round-trip time |
| `rtms_reconnection_count{region}` | Reconnections per meeting |

**Alert if**:
- `keepalive_rtt_ms > 50ms` for in-region (indicates local network issue)
- `keepalive_rtt_ms > 200ms` for any connection (may need regional workers)

### Fallback Strategy

When regional workers are unavailable:

```
1. Primary: Same region worker (SIN → worker-ap-southeast-1)
   └── If unavailable:
   
2. Secondary: Same continent worker (SIN → worker-ap-northeast-1)
   └── If unavailable:
   
3. Tertiary: Any available worker
   └── Log warning: "Cross-region assignment"
   └── Monitor latency closely
```

### Cost Optimization

Regional deployment increases infrastructure cost. Balance with:

| Strategy | Pros | Cons |
|----------|------|------|
| All regions | Lowest latency | Highest cost |
| Major regions only (US, EU, APAC) | Good balance | Some cross-region |
| Single region | Lowest cost | High latency for some |

**Recommendation**: Start with 3 regions (US, EU, APAC hub), expand based on traffic patterns.

### Frame Loss & Keyframe Recovery

When workers are geographically distant from Zoom's data centers, **frame loss is inevitable**—not just possible. High latency and network jitter cause packets to arrive late or not at all.

**Impact by media type:**

| Media Type | Frame Loss Impact | Recovery |
|------------|-------------------|----------|
| **Audio** | Brief glitch/silence | Next packet (~20-100ms) |
| **Transcript** | Missed words | Next transcript event |
| **Chat** | Rare (TCP reliable) | Retransmit |
| **Video** | Corruption/artifacts | **Must wait for next keyframe** |
| **Screen Share** | Corruption/artifacts | **Must wait for next keyframe** |

### The Keyframe Problem

Video codecs (H.264, VP8) use two frame types:

- **I-frames (Keyframes)**: Complete image, can be decoded independently
- **P-frames (Delta frames)**: Only changes from previous frame, requires previous frames

```
Timeline:
  I ──► P ──► P ──► P ──► P ──► I ──► P ──► P ──► P ──► P ──► I
  │                             │                             │
  Keyframe                    Keyframe                     Keyframe
  (complete)                  (complete)                   (complete)
```

**When a P-frame is lost:**

```
  I ──► P ──► P ──► [LOST] ──► P ──► P ──► I
                      │         │     │
                      ▼         ▼     ▼
                   Cannot    Decoding  Finally
                   decode    errors/   recovers
                             artifacts
```

The decoder cannot reconstruct the frame because it depends on the lost frame. **All subsequent P-frames will have errors** until the next keyframe arrives.

### Keyframe Interval Impact

| Keyframe Interval | Recovery Time | Bandwidth |
|-------------------|---------------|-----------|
| Every 1 second | Up to 1s corruption | Higher |
| Every 2 seconds | Up to 2s corruption | Medium |
| Every 5 seconds | Up to 5s corruption | Lower |

RTMS keyframe intervals vary depending on stream configuration. If you lose a frame, video corruption will persist until the next keyframe arrives—which could be **several seconds**.

### Mitigation Strategies

#### 1. Deploy Workers Close to Zoom DCs (Best Solution)

```
Frame loss rate:
  Same region:     < 0.1%  (rarely noticeable)
  Same continent:  0.5-2%  (occasional glitches)
  Cross-continent: 2-10%+  (frequent corruption)
```

#### 2. Request More Frequent Keyframes

If your use case tolerates higher bandwidth, request shorter keyframe intervals in `media_params`:

```javascript
video: {
  codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
  resolution: MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
  fps: 25,
  // Note: Keyframe interval may be controlled by Zoom, not client
}
```

#### 3. Implement Keyframe Request (If Supported)

Some protocols allow requesting an immediate keyframe (PLI - Picture Loss Indication). Check RTMS documentation for availability.

#### 4. Buffer and Validate Frames

For recording use cases, detect corruption and:
- Log frame loss events
- Insert black frames or duplicate last good frame
- Mark segments as potentially corrupted

```javascript
let lastGoodFrame = null;
let corruptedSince = null;

RTMSManager.on('video', ({ buffer, timestamp, isKeyframe }) => {
  if (isKeyframe) {
    // Keyframe received - corruption ends
    if (corruptedSince) {
      const duration = timestamp - corruptedSince;
      logger.warn(`Video corrupted for ${duration}ms, recovered at keyframe`);
      corruptedSince = null;
    }
    lastGoodFrame = buffer;
  } else if (detectCorruption(buffer)) {
    // P-frame corrupted - mark start of corruption
    if (!corruptedSince) {
      corruptedSince = timestamp;
    }
    // Optionally: insert lastGoodFrame or black frame
  }
});
```

#### 5. Accept Degradation for Live Use Cases

For real-time applications (live streaming, live transcription):
- Frame loss may be acceptable
- Don't buffer waiting for recovery
- Let the stream continue with artifacts

For recording applications:
- Consider dual-region recording for redundancy
- Post-process to detect and flag corrupted segments

### Monitoring Frame Loss

Track these metrics per region:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `rtms_video_frames_lost` | Frames not received | > 1% |
| `rtms_video_keyframes_received` | Keyframe count | Monitor for gaps |
| `rtms_video_corruption_duration_ms` | Time between loss and keyframe | Depends on keyframe interval |
| `rtms_audio_packets_lost` | Audio packet loss | > 0.5% |

### Summary

**If you must use cross-region workers:**
- Expect video corruption lasting until next keyframe (could be several seconds)
- Audio recovers quickly (~100ms)
- Transcripts may miss words
- For critical recordings, deploy workers in the same region as the Zoom DC

**The only real solution is regional affinity** - deploy workers close to Zoom's data centers.
