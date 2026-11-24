# Deploy meeting-media archival to Amazon S3

This application runs as one public web service. It needs persistent working
storage for unfinished recordings and the durable upload queue, even though
completed media is uploaded to Amazon S3.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `storage/save_audio_and_video_to_aws_s3_storage_js/render.yaml`. The
Blueprint creates the Docker service and a 20 GB disk mounted at the recording
and queue path.

Provide Zoom credentials, an S3 bucket and region, and AWS credentials limited
to the required bucket operations. Set the Zoom webhook to
`https://YOUR_RENDER_HOST/webhook`.

## Railway

Create a service from the repository root and apply
`storage/save_audio_and_video_to_aws_s3_storage_js/railway.json`. Attach a
volume at the required mount path, add the variables from `.env.example`, and
generate a public domain.

Railway's legacy `railway.json` configuration is included for repository
compatibility. Create and publish a Railway template after testing the service,
volume, and S3 permissions in the Zoom-owned Railway workspace.
