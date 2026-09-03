# AI-Assisted Meeting Video Editor

Record mixed Zoom RTMS audio, active-speaker video, and transcript data, then use an AI-generated Edit Decision List (EDL) to produce a shorter edited MP4.

The AI never generates or executes shell commands. It selects transcript-backed time ranges and a supported visual style; deterministic application code validates the plan and invokes FFmpeg with fixed argument arrays.

## Pipeline

```text
Zoom RTMS
  -> mixed PCM audio + active-speaker H.264 + timestamped transcript
  -> mixed_final.mp4 + transcript.json
  -> AI planning endpoint
  -> validated edits/edit-plan.json
  -> deterministic FFmpeg segment render
  -> edits/final-edit.mp4
```

This design takes inspiration from the manifest, multi-pass render, and verification lessons in [`ffmpeg-vlog-pipeline`](https://github.com/limchinhan123/ffmpeg-vlog-pipeline), but it is implemented independently for synchronized RTMS meeting media. It does not reuse that project's travel footage, assets, scripts, fixed vertical format, fonts, or music workflow.

## Current Editing Features

- Transcript-driven selection with participant names and source-relative timestamps
- Reviewable JSON edit plans
- `hard-cut`, `fade`, and `dissolve` transitions
- Source, `16:9`, `9:16`, or `1:1` output framing
- Minimum segment and maximum output-duration guardrails
- Local CLI with separate plan and render operations so plans can be reviewed or edited manually
- Optional automatic plan and render after `meeting.rtms_stopped`
- Persisted AI response, brief, plan, filter graph, segments, and render result

The first version intentionally does not let the model invent arbitrary filters, download music, generate overlays, or run commands.

## Prerequisites

- Node.js 20.3 or newer
- FFmpeg and FFprobe on `PATH`
- A Zoom General App with RTMS enabled
- RTMS audio, video, and transcript access
- An OpenAI-compatible chat-completions endpoint with a model that can return JSON

## Install

```bash
cd storage/save_edited_audio_and_video_to_local_storage_js
npm install
cp .env.example .env
npm start
```

Expose `WEBHOOK_PATH` over HTTPS and configure that URL as the Zoom app's RTMS webhook endpoint.

## Environment

### Zoom and RTMS

| Variable | Required | Description |
|---|---:|---|
| `ZOOM_SECRET_TOKEN` | Yes | Zoom webhook secret token |
| `ZOOM_CLIENT_ID` | Yes | RTMS client ID |
| `ZOOM_CLIENT_SECRET` | Yes | RTMS client secret |
| `PORT` | No | HTTP port; defaults to `3000` |
| `WEBHOOK_PATH` | No | Webhook path; defaults to `/webhook` |
| `RTMSTRIGGERMANAGERTYPE` | No | `webhook` or `websocket` |
| `zoomWSURLForEvents` | For WebSocket mode | Zoom event WebSocket URL containing the subscription ID |
| `ZOOM_S2S_CLIENT_ID` | For WebSocket mode | Server-to-Server OAuth client ID |
| `ZOOM_S2S_CLIENT_SECRET` | For WebSocket mode | Server-to-Server OAuth client secret |
| `ZOOM_ACCOUNT_ID` | For WebSocket mode | Zoom account ID used for Server-to-Server OAuth |
| `VIDEO_CLIENT_ID` | For Video SDK RTMS | Video SDK client ID |
| `VIDEO_CLIENT_SECRET` | For Video SDK RTMS | Video SDK client secret |
| `VIDEO_SECRET_TOKEN` | For Video SDK RTMS | Video SDK webhook secret token |
| `LOG_LEVEL` | No | RTMSManager log level; defaults to `info` |
| `MEDIA_SOCKET_CONNECTION_MODE` | No | Use `split` for audio, video, and transcript |
| `MEDIA_TYPES_FLAG` | Yes | Use `11`: audio `1` + video `2` + transcript `8` |

### AI Editor

| Variable | Required | Description |
|---|---:|---|
| `AI_API_URL` | Yes | OpenAI-compatible chat-completions URL |
| `AI_API_KEY` | Yes | AI provider credential; never exposed to clients |
| `AI_MODEL` | Yes | JSON-capable model identifier |
| `AI_MIN_SEGMENT_MS` | No | Minimum accepted clip length; defaults to `800` |
| `AI_MAX_OUTPUT_SECONDS` | No | Maximum selected source duration; defaults to `300` |
| `AI_AUTO_EDIT_ON_STOP` | No | Automatically plan and render after muxing; defaults to `false` |
| `AI_DEFAULT_EDITING_BRIEF` | No | Brief used for automatic editing |

Keep `AI_AUTO_EDIT_ON_STOP=false` until generated plans have been reviewed against representative meetings.

### Using OpenAI Directly

The implementation sends a [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) request and reads `choices[0].message.content`. OpenAI's compatible endpoint for this request shape is:

```text
https://api.openai.com/v1/chat/completions
```

Create an OpenAI API key, then configure:

```env
AI_API_URL=https://api.openai.com/v1/chat/completions
AI_API_KEY=replace_with_your_openai_api_key
AI_MODEL=gpt-5.6-terra
```

[`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra) supports Chat Completions and structured output. Model access can depend on the OpenAI project and account, so replace it with another Chat Completions model available to your project if necessary.

Do not change `AI_API_URL` to `https://api.openai.com/v1/responses` without changing `lib/editPlanner.js`. The Responses API uses a different request and response schema. OpenAI API usage also requires API billing; a ChatGPT subscription does not automatically provide API credits.

Keep the key only in `.env`. Never put it in `.env.example`, frontend JavaScript, an editing brief, or committed files.

## Output Layout

```text
recordings/<meeting>/<stream>/
├── mixed_audio.raw
├── mixed_audio.wav
├── mixed_video.h264
├── mixed_video.mp4
├── mixed_final.mp4
├── transcript.json
└── edits/
    ├── editing-brief.txt
    ├── ai-response.json
    ├── edit-plan.json
    ├── concat.txt or filtergraph.txt
    ├── render-result.json
    ├── segments/
    └── final-edit.mp4
```

The entire `recordings/` tree is ignored by Git.

## Local Editing CLI

Editing is deliberately not exposed over HTTP. Express serves only the Zoom webhook. Run editing commands directly on the backend host from this project directory.

List locally available recordings:

```bash
npm run edit -- list
```

Generate and save a plan without rendering:

```bash
npm run edit -- plan MEETING_ID STREAM_ID \
  --brief "Create a 60-second customer story. Keep the problem, decision, and outcome."
```

Render the saved plan:

```bash
npm run edit -- render MEETING_ID STREAM_ID
```

Generate and render in one local command:

```bash
npm run edit -- run MEETING_ID STREAM_ID \
  --brief "Remove repetition and produce a concise internal update."
```

`MEETING_ID` and `STREAM_ID` are the sanitized directory names printed by the `list` command. Plans and final videos remain on the local filesystem.

## Edit Plan Contract

```json
{
  "version": 1,
  "title": "Product decision recap",
  "summary": "Problem, options, decision, and next step.",
  "style": "dissolve",
  "transitionMs": 350,
  "aspectRatio": "16:9",
  "segments": [
    {
      "startMs": 12500,
      "endMs": 28400,
      "label": "Problem statement",
      "reason": "Provides necessary context"
    }
  ]
}
```

Validation rejects missing segments, overlaps, out-of-range timestamps, clips below the minimum duration, unsupported styles, and plans exceeding the output limit.

## Accuracy and Safety

- Keep transcript timestamps alongside raw Zoom values for diagnostics.
- Review the EDL before rendering important or externally published content.
- The model can remove context and change perceived meaning even when timestamps are valid.
- Final segments are always extracted from `mixed_final.mp4`, so visible video and conversation audio remain mapped to the same source timeline.
- No editing API or static media route is registered. Generated media remains local unless you deliberately add a delivery mechanism.
- `.env`, logs, raw media, generated plans, AI responses, and final videos must remain uncommitted.

## Tests

```bash
npm test
```

The tests cover transcript timestamp normalization and EDL validation. A full FFmpeg integration test requires representative RTMS media and is intentionally not included in the repository.

## Docker

The project records RTMS media and performs transcript-guided local video editing. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f storage/save_edited_audio_and_video_to_local_storage_js/Dockerfile -t rtms-storage-save_edited_audio_and_video_to_local_storage_js .
docker run --rm --env-file storage/save_edited_audio_and_video_to_local_storage_js/.env -p 3000:3000 rtms-storage-save_edited_audio_and_video_to_local_storage_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context. Mount the sample's generated output directory as a volume when recordings must survive container replacement.
