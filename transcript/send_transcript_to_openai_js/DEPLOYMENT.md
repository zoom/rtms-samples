# Deploy transcripts to LLMs

This application runs as one public, long-running web service. Build it from
the `rtms-samples` repository root so Docker can copy the shared JavaScript
library.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `transcript/send_transcript_to_openai_js/render.yaml`. The Blueprint builds
the nested Dockerfile, exposes the webhook service, and prompts for the Zoom
and OpenAI credentials.

After deployment, set the Zoom event-subscription endpoint to
`https://YOUR_RENDER_HOST/webhook` and confirm that `/health` returns
`{"status":"ok"}`.

## Railway

Create a service from `zoom/rtms-samples`. Keep the repository root as the
build context and apply the settings in
`transcript/send_transcript_to_openai_js/railway.json`. Add the variables from
`.env.example`, generate a public domain, and configure the Zoom webhook as
`https://YOUR_RAILWAY_HOST/webhook`.

Railway's legacy `railway.json` configuration is included for repository
compatibility. Create and publish a Railway template after testing the service
in the Zoom-owned Railway workspace; use that template URL for a one-click
deploy button.
