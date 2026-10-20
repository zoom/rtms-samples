# Deploy deepfake detection in meetings

The included deployment configuration runs the Zoom App, RTMS media pipeline,
HLS preview, and inference adapters. It does not provision a deepfake model.
Provide commercial inference endpoints or customer-operated model endpoints,
including services built from suitable Hugging Face models.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `zoom_apps/stream_audio_and_video_deepfake_detection_js/render.yaml`. The
Blueprint creates the public Docker service and prompts for Zoom credentials
and both inference-service endpoints.

Set the app's public URL and webhook URL in Zoom Marketplace after Render
assigns the service domain. Confirm `/health` reports a healthy application,
then test each configured inference service separately.

## Railway

Create a service from the repository root and apply
`zoom_apps/stream_audio_and_video_deepfake_detection_js/railway.json`. Add the
variables from `.env.example`, generate a public domain, and supply reachable
video and audio inference endpoints.

Railway's legacy `railway.json` configuration is included for repository
compatibility. Create and publish a Railway template after testing the Zoom
App URL, WebSocket delivery, HLS output, and customer-provided inference
connections in the Zoom-owned Railway workspace.
