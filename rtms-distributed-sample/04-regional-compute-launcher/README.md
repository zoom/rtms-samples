# Regional Compute Launcher

[Back to distributed sample overview](../README.md)

The launcher turns one accepted RTMS stream envelope into one deterministic Kubernetes Job.

It is useful when the regional spoke should not run media processing itself. The spoke calls the launcher, and the launcher creates the pod that runs [`04-regional-compute-job`](../04-regional-compute-job/README.md).

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Launcher, Kubernetes, image, and media flag config |
| `POST /compute/webhook` | Start or stop envelope from the spoke |

## Run

```bash
SPOKE_REGION=IAD \
COMPUTE_LAUNCHER_PORT=4710 \
REGIONAL_STORE_URL=http://127.0.0.1:4101 \
KUBECONFIG=/path/to/k3s-remote.yaml \
K8S_NAMESPACE=rtms \
K8S_COMPUTE_IMAGE=rtms-distributed-compute:local \
npm run start:compute-launcher
```

For a distributed deployment, the launcher needs two kinds of URLs:

- URLs the launcher can call, such as `REGIONAL_STORE_URL`
- URLs the Kubernetes compute pod can call, such as `COMPUTE_ARTIFACT_STORAGE_URL`, `COMPUTE_REALTIME_CACHE_URL`, `COMPUTE_LOKI_PUSH_URL`, `COMPUTE_REGIONAL_STORE_URL`, and `COMPUTE_CENTRAL_STORE_URL`

These can be FQDNs, internal load balancers, Kubernetes service DNS names, or service-mesh names. They do not need to expose explicit ports.

Build the compute image from inside `rtms-distributed-sample`:

```bash
npm run docker:build:compute
```

## Main Config

| Key | Purpose |
|-----|---------|
| `COMPUTE_LAUNCHER_PORT` | Local listen port, default `4710` |
| `KUBECONFIG` / `KUBECONFIG_INLINE_B64` | Kubernetes access |
| `K8S_NAMESPACE` | Namespace for Jobs |
| `K8S_COMPUTE_IMAGE` | Image used by compute Jobs |
| `K8S_COMPUTE_SECRET_NAME` | Optional mounted credentials Secret |
| `COMPUTE_ARTIFACT_STORAGE_URL` | Artifact API URL reachable from pods |
| `COMPUTE_REALTIME_CACHE_URL` | Cache API URL reachable from pods |
| `MEDIA_TYPES_FLAG` | RTMS media request, default `32` |

## Notes

For mutable local image tags, use `K8S_IMAGE_PULL_POLICY=Always`. For production-style deployments, prefer immutable tags or image digests.

## Related

- [Regional spoke](../03-regional-webhook-spoke/README.md)
- [Compute job](../04-regional-compute-job/README.md)
- [Kubernetes launcher helper](../shared/README.md)
