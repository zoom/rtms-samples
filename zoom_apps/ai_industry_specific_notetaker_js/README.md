# AI Industry-Specific Notetaker

An intelligent meeting assistant that uses AI to analyze transcripts in real-time, extracting named entities, action items, topics, and generating summaries.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample demonstrates AI-powered meeting analysis using RTMS transcript streams. As participants speak, the app processes each transcript segment through multiple NLP pipelines: Named Entity Recognition (NER) extracts people, organizations, and key terms; action item detection identifies tasks and commitments; topic classification categorizes discussion themes; and periodic summarization condenses the conversation. Results are broadcast to the frontend via WebSocket for real-time display.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace
- OpenRouter API key for AI model access
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Webhook validation token from Zoom Marketplace |
| `ZOOM_CLIENT_ID` | Yes | Your Zoom App's Client ID |
| `ZOOM_CLIENT_SECRET` | Yes | Your Zoom App's Client Secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | No | WebSocket URL for frontend connection |
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter AI models |
| `NER_MODEL` | No | Model for entity extraction (default: mistralai/mistral-7b-instruct) |
| `SUMMARY_MODEL` | No | Model for summarization (default: mistralai/mistral-7b-instruct) |
| `TOPIC_MODEL` | No | Model for topic classification (default: mistralai/mistral-7b-instruct) |
| `EMBEDDING_MODEL` | No | Model for embeddings (default: openai/text-embedding-ada-002) |

## Code Walkthrough

### RTMSManager Configuration

```javascript
const rtmsConfig = {
  logging: 'info',
  logDir: path.join(__dirname, 'logs'),
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      zoomSecretToken: process.env.ZOOM_SECRET_TOKEN,
    },
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
      sendRate: 100,
    },
    transcript: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
      language: MEDIA_PARAMS.LANGUAGE_ID_ENGLISH,
    },
  }
};
```

### AI-Powered Transcript Processing

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId }) => {
  transcriptHistory.push(text);

  // Run NLP analysis in parallel
  const ner = await detectEntities(text);
  const actions = detectActionItems(text);
  const topic = await classifyTopic(text);

  if (actions.length) actionItems.push(...actions);
  if (topic) topics.add(topic);

  // Generate summary every 5 transcript segments
  if (transcriptHistory.length % 5 === 0) {
    summary = await summarize(transcriptHistory.join(' '));
  }

  // Broadcast results to frontend
  frontendWssManager.broadcastToFrontendClients({
    type: 'transcript',
    content: formatted,
    user: userName,
    timestamp: Date.now()
  });
});
```

### Named Entity Recognition (NER)

```javascript
// nlp/ner.js
export default async function detectEntities(text) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'Extract named entities from the following text. Respond with JSON only.',
        },
        { role: 'user', content: `Text: ${text}\nOnly return valid JSON.` },
      ],
    }),
  });
  // Parse and return entities
}
```

### Action Item Detection

```javascript
// nlp/actionItems.js - Pattern-based action item detection
export default function detectActionItems(text) {
  const actions = [];
  const regex = /\b(we need to|let's|assign|follow up|I'll|you should)\b.+?[.?!]/gi;
  let match;
  while ((match = regex.exec(text))) {
    actions.push(match[0]);
  }
  return actions;
}
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main application - sets up RTMSManager and processes transcripts |
| `nlp/ner.js` | Named Entity Recognition using AI models |
| `nlp/summarizer.js` | Meeting summarization using AI models |
| `nlp/actionItems.js` | Pattern-based action item detection |
| `nlp/topicClassifier.js` | Topic classification using AI models |
| `nlp/embedder.js` | Text embedding generation (optional) |
| `public/index.ejs` | Frontend template with WebSocket client |
| `.env.example` | Environment variable template |

## How It Works

1. **Webhook Reception**: Zoom sends `meeting.rtms_started` webhook when RTMS is enabled
2. **RTMSManager Connection**: Automatically connects to the RTMS WebSocket stream
3. **Transcript Streaming**: Real-time transcripts flow through the `transcript` event
4. **NLP Pipeline**: Each transcript segment is analyzed by multiple AI models:
   - Entity extraction identifies names, organizations, key terms
   - Action item detection finds commitments and tasks
   - Topic classification categorizes the discussion
5. **Periodic Summarization**: Every 5 segments, the accumulated transcript is summarized
6. **Frontend Broadcast**: Results are sent to connected frontend clients via WebSocket
7. **State Reset**: When RTMS stops, analysis state is cleared for the next meeting

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "OpenRouter API error" | Verify `OPENROUTER_API_KEY` is valid and has credits |
| No transcripts appearing | Ensure Zoom meeting has live transcription enabled |
| NER returning raw text | Some models don't follow JSON format strictly; the code handles this |
| Summary not generating | Summaries generate every 5 transcript segments; wait for more speech |
| WebSocket not connecting | Check `FRONTEND_WSS_URL_TO_CONNECT_TO` matches your ngrok URL |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project runs an industry-focused AI meeting notetaker Zoom App. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_industry_specific_notetaker_js/Dockerfile -t rtms-zoom_apps-ai_industry_specific_notetaker_js .
docker run --rm --env-file zoom_apps/ai_industry_specific_notetaker_js/.env -p 3000:3000 rtms-zoom_apps-ai_industry_specific_notetaker_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
