# Send Audio to OpenAI Realtime API with Zoom App Audio Playback

This Zoom App sample builds on [`audio/send_audio_to_openai_realtime_api`](../../audio/send_audio_to_openai_realtime_api) and selectively reuses the browser playback pattern from [`zoom_apps/ai_chat_with_audio_playback_js`](../ai_chat_with_audio_playback_js).

It streams live Zoom RTMS meeting audio to the OpenAI Realtime API, enables Zoom MCP tools, receives OpenAI Realtime audio output, and plays that audio inside the Zoom App webview.

## What This Sample Does

1. Runs an Express app with a Zoom App frontend.
2. Uses the Zoom App SDK frontend to start and stop RTMS.
3. Receives Zoom RTMS mixed audio as mono L16.
4. Resamples RTMS audio to 24 kHz PCM16 for OpenAI Realtime.
5. Configures `gpt-realtime-2` for audio output with a selectable voice.
6. Streams OpenAI output PCM audio chunks to the Zoom App frontend over WebSocket.
7. Plays audio in the Zoom App webview using Web Audio.
8. Shows the assistant's spoken transcript in the Zoom App page.
9. Stops queued/current assistant audio when the user interrupts with new speech.
10. Sends playback truncation metadata back to OpenAI using `conversation.item.truncate`.

This plays audio inside the Zoom App webview. It does not inject the assistant audio as a meeting participant microphone track.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Expose the app over HTTPS for Zoom App testing:

```bash
ngrok http 5050
```

Configure your Zoom App domain allowlist with the HTTPS ngrok or deployed domain. Set `FRONTEND_WSS_URL_TO_CONNECT_TO` to the matching `wss://.../ws` URL.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Zoom webhook secret token |
| `ZOOM_CLIENT_ID` | Yes | Zoom app client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Zoom app client secret |
| `PORT` | No | Server port, default `5050` |
| `WEBHOOK_PATH` | No | Webhook path, default `/webhook` |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | Public frontend WebSocket URL. If omitted, the server derives `/ws` from the request host |
| `MODE` | No | `webhook` or `websocket`, default `webhook` |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_REALTIME_MODEL` | No | Realtime model, default `gpt-realtime-2` |
| `OPENAI_REALTIME_VOICE` | No | Audio output voice, default `marin` |
| `OPENAI_AUDIO_SAMPLE_RATE` | No | OpenAI PCM sample rate, must be `24000` |
| `OPENAI_REALTIME_TRANSCRIPTION_ENABLED` | No | Enable async input transcription logs and UI transcript messages, default `true` |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | No | Transcription model, default `gpt-4o-mini-transcribe` |
| `OPENAI_REALTIME_COST_LOGGING_ENABLED` | No | Log per-response and per-meeting model token cost estimates, default `true` |
| `OPENAI_FORCE_RESPONSE_AFTER_SPEECH_STOP_MS` | No | If server VAD speech stops but no response starts, force `response.create` after this delay. Default `1800`; set `0` to disable |
| `OPENAI_RESPONSE_NO_OUTPUT_WARNING_MS` | No | Log and show a status if a response starts but produces no audio/text output after this delay. Default `8000` |
| `OPENAI_MCP_LONG_RUNNING_WARNING_MS` | No | Log and show a status if an MCP call is still running after this delay. Default `10000` |
| `OPENAI_IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS` | No | Ignore very early `speech_started` after assistant audio begins to reduce self-interruption from speaker echo. Default `700` |
| `ZOOM_MCP_SERVER_URL` | Yes | Zoom MCP server URL, default `https://mcp-us.zoom.us/mcp/zoom/streamable` |
| `ZOOM_MCP_ACCESS_TOKEN` | Yes | Zoom user OAuth token for MCP. This token expires; refresh it when logs say MCP is disabled or tool listing fails |
| `ZOOM_MCP_ALLOWED_TOOLS` | No | Comma-separated MCP tool allowlist |
| `ZOOM_MCP_REQUIRE_APPROVAL` | No | MCP approval policy, default `never` |
| `AUDIO_SAMPLE_RATE` | No | RTMS input sample rate. Use `8000`, `16000`, `32000`, or `48000`; default `48000` |
| `TARGET_CHUNK_DURATION_MS` | No | Audio chunk size sent to OpenAI, default `100` |

Default Zoom MCP allowlist:

```text
search_meetings,search_zoom,get_meeting_assets,get_recording_resource,get_file_content,recordings_list,create_new_file_with_markdown
```

`create_new_file_with_markdown` writes Zoom Docs. The assistant instructions restrict it to explicit requests to create, save, or write a Zoom Doc. For stricter production behavior, put write tools behind an approval flow or a backend function that validates the content before writing.

When MCP is available, the backend logs:

```text
Zoom MCP: enabled - token expires at ...
MCP tools ready on zoom: ...
```

If the Zoom OAuth token has expired, the backend disables MCP for that session and sends a frontend error instead of silently letting the assistant claim tools are unavailable.

Zoom MCP access tokens are short lived. After updating `.env`, restart the Node process; an already-running process will keep the old token in memory.

## Interruption Behavior

The Realtime session sets:

```js
turn_detection: {
  type: 'server_vad',
  create_response: true,
  interrupt_response: true
}
```

When OpenAI emits `input_audio_buffer.speech_started`, the backend broadcasts an `interrupt` message to the Zoom App frontend. The frontend immediately stops the active Web Audio source, clears queued audio chunks, and sends the last played audio position back to the backend. `interrupt_response: true` lets OpenAI cancel the active response, and the backend sends `conversation.item.truncate` so the server-side conversation state better matches what the user actually heard.

This is the same practical pattern used by realtime voice demos: stop local playback immediately, cancel active generation where needed, then synchronize the model conversation state.

## Notes

- Use headphones during testing if the meeting microphone can pick up the Zoom App webview audio.
- OpenAI output audio is PCM16 at 24 kHz and is played by the browser. RTMS input defaults to 48 kHz and is downsampled to 24 kHz before being sent to OpenAI.
- The frontend uses `getRTMSStatus` and `onRTMSStatusChange` to keep the Start RTMS and Stop RTMS buttons aligned with the current Zoom RTMS state.
- If the assistant response seems delayed, watch for `User speech stopped`, `Creating response`, `Response created`, and `outputAudioDeltas` logs. These show whether the issue is VAD turn detection, OpenAI response generation, or browser playback.
- Use headphones during testing. If the meeting microphone hears the Zoom App's speaker output, Realtime may detect that as new user speech and interrupt the assistant.
- Cost logs are estimates from Realtime `response.done` usage events. They are directional and may differ from actual billing.
- Raw MCP outputs are hidden from logs by default. Console logs show compact result summaries, while the assistant is instructed to summarize MCP results instead of reading raw payloads aloud.

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Express app, Zoom RTMS setup, webhook/websocket event handling |
| `openaiRealtime.js` | OpenAI Realtime WebSocket client, audio input/output, Zoom MCP config, interruption handling |
| `frontendWss.js` | WebSocket bridge between backend and Zoom App frontend |
| `public/audio-client.js` | Browser-side PCM playback queue and interruption/truncation reporting |
| `public/index.ejs` | Zoom App UI |
| `.env.example` | Environment variable template |
