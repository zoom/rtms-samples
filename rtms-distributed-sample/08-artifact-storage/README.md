# Artifact Storage

[Back to distributed sample overview](../README.md)

This service gives compute pods one upload API for final artifacts. The service writes bytes to local disk, MinIO/S3, Azure Blob Storage, or Google Cloud Storage.

The compute pod should upload final files here instead of talking directly to every storage provider.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Storage provider health |
| `POST /artifacts` | JSON/text/base64 artifact upload |
| `PUT /streams/:streamId/artifacts/:artifactType/:fileName` | Raw byte upload |

## Run

Local filesystem:

```bash
ARTIFACT_STORAGE_PROVIDER=local \
ARTIFACT_LOCAL_ROOT=.data/artifacts \
npm run start:artifact-storage
```

Local MinIO:

```bash
docker compose up -d object-storage

ARTIFACT_STORAGE_PROVIDER=minio \
ARTIFACT_BUCKET=rtms-artifacts \
ARTIFACT_S3_ENDPOINT=http://127.0.0.1:9002 \
ARTIFACT_S3_FORCE_PATH_STYLE=true \
ARTIFACT_S3_CREATE_BUCKET=true \
AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
npm run start:artifact-storage
```

## Upload Examples

JSON/text upload:

```bash
curl -s http://127.0.0.1:4550/artifacts \
  -H 'content-type: application/json' \
  -d '{
    "streamId": "abc123",
    "regionCode": "IAD",
    "productType": "meeting",
    "artifactType": "summary_final",
    "fileName": "final.md",
    "contentType": "text/markdown",
    "content": "# Final Summary\n"
  }'
```

Raw byte upload:

```bash
curl -s -X PUT \
  'http://127.0.0.1:4550/streams/abc123/artifacts/audio_final/final-audio.wav?regionCode=IAD&productType=meeting' \
  -H 'content-type: audio/wav' \
  --data-binary @final-audio.wav
```

## Main Config

| Key | Purpose |
|-----|---------|
| `ARTIFACT_STORAGE_PORT` | HTTP port, default `4550` |
| `ARTIFACT_STORAGE_PROVIDER` | `local`, `minio`, `s3`, `azure`, or `gcs` |
| `ARTIFACT_BUCKET` | S3/MinIO bucket |
| `ARTIFACT_S3_ENDPOINT` | S3-compatible endpoint |
| `ARTIFACT_LOCAL_ROOT` | Local provider root |
| `ARTIFACT_METADATA_STORE_URL` | Optional control-store metadata target |

## Related

- [Compute job media recording](../04-regional-compute-job/README.md)
- [Control store](../05-control-store/README.md)
- [Storage helper](../shared/README.md)
