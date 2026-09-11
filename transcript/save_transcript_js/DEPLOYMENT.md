# Deploy the transcript knowledge-base foundation

This application runs as one public web service and writes transcript artifacts
to `/app/recordings`. Attach persistent storage at that path or the files will
be lost when the container is replaced.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `transcript/save_transcript_js/render.yaml`. The Blueprint creates the
Docker service and a 10 GB persistent disk. It prompts for the Zoom
credentials.

After deployment, set the Zoom event-subscription endpoint to
`https://YOUR_RENDER_HOST/webhook` and confirm that `/health` returns
`{"status":"ok"}`.

## Railway

Create a service from `zoom/rtms-samples`, keep the repository root as the
build context, and apply `transcript/save_transcript_js/railway.json`. Attach a
volume at `/app/recordings`, add the variables from `.env.example`, and
generate a public domain.

Railway's legacy `railway.json` configuration is included for repository
compatibility. Create and publish a Railway template after testing the service
and volume in the Zoom-owned Railway workspace.

This deployment persists VTT, SRT, TXT, and JSONL files. It does not provision
a search index. Connect the output to the search or object-storage service
used in your environment when building a larger knowledge base.
