# Deploy the OpenAI voice agent for Zoom Meetings

This application runs as one public, long-running web service. It receives
meeting audio through RTMS, maintains outbound OpenAI Realtime connections,
and serves the Zoom App that plays assistant audio in its webview.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js/render.yaml`.
The Blueprint builds the Docker service and prompts for Zoom, OpenAI, and
optional Zoom MCP credentials.

After deployment, configure the Zoom App home URL, domain allowlist, frontend
WebSocket URL, and RTMS webhook with the Render service domain. Confirm that
`/health` returns `{"status":"ok"}` before testing in a meeting.

## Railway

Create a service from the repository root and apply
`zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js/railway.json`.
Add the variables from `.env.example`, generate a public domain, and configure
the Zoom App and webhook with that domain.

Create and publish one-click templates only after testing RTMS input, OpenAI
audio output, browser playback, interruption, and Zoom MCP authorization in
the Zoom-owned platform workspaces.
