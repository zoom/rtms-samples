# Deploy an OpenAI voice agent for Zoom Meetings

This application runs as one public, long-running web service. It receives
meeting audio through RTMS and maintains outbound OpenAI Realtime connections.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `audio/send_audio_to_openai_realtime_api/render.yaml`. The Blueprint builds
the Docker service and prompts for Zoom and OpenAI credentials.

After deployment, configure the Zoom webhook with the Render service URL and
confirm that `/health` returns `{"status":"ok"}`. The default webhook path is
`/`; change `WEBHOOK_PATH` if the deployment shares a host with other routes.

## Railway

Create a service from the repository root and apply
`audio/send_audio_to_openai_realtime_api/railway.json`. Add the variables from
`.env.example`, generate a public domain, and configure the Zoom webhook.

Railway's legacy `railway.json` configuration is included for repository
compatibility. Create and publish a Railway template after testing RTMS audio,
the OpenAI Realtime connection, and webhook delivery in the Zoom-owned Railway
workspace.
