# AI RAG Customer Support

Answer customer questions in real-time using RAG (Retrieval-Augmented Generation) with your knowledge base documents.

> **Built with [RTMSManager](../../library/README.md)** - Zoom's JavaScript library for real-time media streaming.

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your credentials
# Add your knowledge base documents to the docs/ folder
node index.js
```

Expose with ngrok: `ngrok http 3000`

## What This Sample Does

This sample creates an AI-powered customer support assistant that answers questions using your own documentation. It uses LangChain for document loading and chunking, vector embeddings for semantic search, and OpenRouter for AI responses. When customers ask questions during a Zoom meeting, the system retrieves relevant context from your knowledge base and generates accurate, grounded answers.

## Prerequisites

- Node.js v18+
- Zoom account with RTMS enabled
- Zoom App configured in Marketplace (with Zoom Apps SDK capabilities)
- OpenRouter API key (for AI responses)
- Knowledge base documents (PDF, TXT, DOCX, or MD files)
- ngrok for local development

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZOOM_SECRET_TOKEN` | Yes | Secret token from your Zoom app |
| `ZOOM_CLIENT_ID` | Yes | Client ID from your Zoom app |
| `ZOOM_CLIENT_SECRET` | Yes | Client secret from your Zoom app |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: /webhook) |
| `FRONTEND_WSS_URL_TO_CONNECT_TO` | Yes | WebSocket URL for frontend (e.g., wss://yoururl.ngrok.com/ws) |
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter |
| `MODEL_ID` | No | AI model to use (default: meta-llama/llama-4-maverick:free) |
| `EMBEDDING_MODEL_ID` | No | Embedding model (default: thenlper/gte-small) |

## Code Walkthrough

### 1. Preload Document Retriever

```javascript
import { preloadRetrieverOnce, askLLMWithTranscript } from './ragPipeline.js';

await preloadRetrieverOnce();
```

### 2. Initialize RTMSManager

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

await RTMSManager.init(rtmsConfig);
```

### 3. Set Up Webhook Handler

```javascript
const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/',
    zoomSecretToken: rtmsConfig.credentials.meeting.zoomSecretToken,
  },
  app: app
});

webhookManager.on('event', (event, payload) => {
  console.log('[Consumer] Webhook Event:', event);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();
```

### 4. Set Up Frontend Manager and WebSocket

```javascript
const frontendManager = new FrontendManager({
  config: {
    port: appConfig.port,
    serveStaticEnabled: true,
    viewsPath: path.join(__dirname, 'views'),
    staticPath: path.join(__dirname, 'public'),
    frontendWssUrl: process.env.FRONTEND_WSS_URL_TO_CONNECT_TO || '',
    frontendWssPath: '/ws'
  },
  app: app
});
frontendManager.setup();

const frontendWssManager = new FrontendWssManager({
  config: {
    frontendWssEnabled: true,
    frontendWssPath: '/ws'
  },
  server: server
});
frontendWssManager.setup();
```

### 5. Handle Transcript Events with RAG

```javascript
RTMSManager.on('transcript', async ({ text, userId, userName, timestamp, meetingId, streamId, productType }) => {
  console.log('Transcript received:', text);
  const result = await askLLMWithTranscript(text);
  frontendWssManager.broadcastToFrontendClients({
    type: 'transcript',
    content: result,
    user: userName,
    timestamp: Date.now()
  });
});
```

### 6. Start the Server

```javascript
await RTMSManager.start();

server.listen(appConfig.port, () => {
  console.log(`Server running at http://localhost:${appConfig.port}`);
  console.log(`Frontend WebSocket available at ws://localhost:${appConfig.port}/ws`);
});
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point - initializes RTMSManager, managers, and server |
| `ragPipeline.js` | RAG pipeline orchestration - loads docs, creates retriever, queries LLM |
| `chatWithOpenrouter.js` | OpenRouter AI integration |
| `langchain/embedUtils.js` | Document splitting and vector store creation |
| `langchain/contextualQA.js` | Context-aware question answering |
| `loaders/index.js` | Document loader dispatcher |
| `loaders/loadPDF.js` | PDF document loader |
| `loaders/loadTXT.js` | Text file loader |
| `loaders/loadDOCX.js` | Word document loader |
| `loaders/loadMD.js` | Markdown file loader |
| `docs/` | Knowledge base documents folder |
| `views/index.ejs` | Frontend UI template |

## How It Works

1. On startup, documents from `docs/` folder are loaded and processed
2. Documents are split into chunks (1000 chars with 150 overlap)
3. Chunks are embedded and stored in a memory vector store
4. User joins a Zoom meeting with RTMS enabled
5. Zoom sends RTMS events to the webhook endpoint
6. RTMSManager processes events and receives transcripts
7. Customer questions trigger semantic search for relevant context
8. AI generates responses using retrieved context:
   ```javascript
   const prompt = `
   <scenario>
     <role>customer_support</role>
     <input>
       <transcript>${transcript}</transcript>
       <context>${context}</context>
     </input>
     <instruction>
       Use the context to answer the customer's question from the transcript.
       Your answer should be helpful, concise, and formatted in bullet points.
       Do not hallucinate. Only respond using information from the transcript or context.
     </instruction>
   </scenario>
   `;
   ```
9. Responses are broadcast to the frontend for display

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No documents loaded | Add PDF, TXT, DOCX, or MD files to the `docs/` folder |
| Poor answer quality | Add more relevant documents or adjust chunk size |
| Retriever not initialized | Ensure `preloadRetrieverOnce()` completes before handling events |
| WebSocket disconnects | Verify FRONTEND_WSS_URL_TO_CONNECT_TO matches ngrok URL |
| Webhook not receiving events | Ensure ngrok URL is registered in Zoom Marketplace |

## See Also

- [RTMSManager Library Docs](../../library/README.md) - Full API reference
- [Zoom App Setup Guide](../../ZOOM_APP_SETUP.md) - Configure your Zoom app
- [Troubleshooting Guide](../../TROUBLESHOOTING.md) - Common issues

## Docker

The project runs the retrieval-augmented customer support Zoom App. Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f zoom_apps/ai_rag_customer_support_js/Dockerfile -t rtms-zoom_apps-ai_rag_customer_support_js .
docker run --rm --env-file zoom_apps/ai_rag_customer_support_js/.env -p 3000:3000 rtms-zoom_apps-ai_rag_customer_support_js
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.

## Webhook Delivery Authentication

Normal Zoom webhook deliveries are verified against the exact raw request body using
`x-zm-signature` and `x-zm-request-timestamp`. Configure `ZOOM_SECRET_TOKEN` with the
Marketplace app's webhook Secret Token. Requests with missing, invalid, or stale
signatures are rejected; the default replay window is 300 seconds and can be changed
with `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`.
