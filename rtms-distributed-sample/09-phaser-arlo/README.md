# Pixi Arlo Workshop

[Back to distributed sample overview](../README.md)

This is a single-page PixiJS view of the RTMS distributed flow, using the same web-rendering direction as AI Town. It turns active stream records from the realtime cache into small Arlo characters that move through the architecture:

```text
Zoom webhook -> centralized hub -> dispatcher -> selected region -> handoff lane
  -> regional Kubernetes launcher -> regional pod workshop
  -> regional realtime cache -> regional logging -> centralized S3 / MinIO
```

Each Arlo uses the local sprite sheet and gets a deterministic color from its `streamId`. The region workshops use the same four route groups as the distributed sample:

- `amer-west`
- `amer-east`
- `europe`
- `apac-hub`

Each region has its own local K8s, pod, cache, and logging workshop on the map. The S3 / MinIO storehouse is the shared centralized exit.

The page starts in dummy mode so it can be used in a workshop without live webhooks or Redis.

Rejected and recovering paths are shown separately:

- unsigned and duplicate webhook attempts stay as normal Arlos until they reach the webhook gate, then change into black-and-white prison stripes and are sent to the police station / jail
- interrupted streams walk to the graveyard with a knocked-out Arlo sprite and then fade away
- temporary disconnects walk to the reconnect hospital; recovered streams return to the regional route, while failed reconnects continue to the graveyard

## Run

From `rtms-distributed-sample`:

```bash
npm run start:phaser-arlo
```

Open:

```text
http://127.0.0.1:4570
```

For a high-density workshop check, use the `Stress 150` button or open:

```text
http://127.0.0.1:4570/?stress=150
```

When the page has more than 120 moving Arlos, it keeps every Arlo visible but uses smaller static sprites with no per-Arlo input hitbox, bobbing, or frame animation. Above 250 it can fall back to a compact batched Pixi graphics path. The normal detailed sprites come back automatically when the count drops.

## Config

| Key | Purpose |
|-----|---------|
| `PHASER_ARLO_PORT` | Web UI port, default `4570` |
| `PHASER_ARLO_REALTIME_CACHE_URL` | Realtime cache API URL, defaults to `REALTIME_CACHE_URL` or `http://127.0.0.1:4560` |
| `PHASER_ARLO_CACHE_TIMEOUT_MS` | Cache proxy timeout, default `1200` |

The browser does not call Redis directly. The page calls the Arlo web service, and the web service proxies these realtime-cache endpoints:

```text
GET /streams
GET /webhooks/stats
```

09 calls `GET /streams?include=all` so it can see fresh terminal states such as `stop_requested`, `stopped`, and `artifact_saved`. The browser still filters out old cache records. It keeps recently stopped streams visible long enough for Arlo to walk to the centralized S3 / MinIO storehouse, then completed artifact streams fade out after a short hold at the exit.

Live Arlos start at the webhook entrance and ease toward the latest stream state reported by the cache. For exact gate, hub, route, hospital, and graveyard timing, each service should write explicit per-stream state or event records into the realtime cache using `streamId` as the key.

If the realtime cache is unavailable, the proxy returns an empty fallback response and the page can continue in dummy mode.

## UI Notes

- Click a workshop, region lodge, pod, cache fountain, log lantern, storage building, or Arlo to show a dialog.
- The right-side stats panel shows concurrent meetings, running pods, completed dummy streams, media volume in MiB, regional distribution, webhook counters, and latency averages.
- If `rtms.concurrency_limited` appears in the recent webhook counters, the stage shows a pixel-fire warning so it is visible during live tests.
- The page is intentionally no-scroll. It is meant to run full-screen on a workshop display.
- Dummy mode simulates accepted streams, rejected webhook attempts, temporary reconnects, failed reconnects, and interrupted streams.
- The town artwork uses pixelated 16-bit-style buildings, fences, plants, paths, region workshops, a police station / jail, a reconnect hospital, and a graveyard.

The current sprite source is `arlo sprite.jpg`. It is colorized in the browser by turning dark pixels into each stream color and dropping the checkerboard background. A transparent PNG sprite sheet would produce a cleaner final asset, but the code already handles the current JPG for the sample.
