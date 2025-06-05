
# Customer Service AI with Zoom RTMS, LangChain, and OpenRouter

This application connects Zoom RTMS (Real-Time Media Streaming) with a retrieval-augmented generation (RAG) system powered by LangChain and OpenRouter LLMs. It is designed to support customer service agents by providing bite-sized, accurate context from live meeting transcripts and documentation.

---

## Key Features

- Zoom RTMS Integration: Receives real-time audio, video, transcript, and chat data from Zoom meetings.
- Document Loader System: Supports `.pdf`, `.docx`, `.txt`, and `.md` files via modular loaders.
- Vector Search with LangChain: Converts documentation into vector embeddings using chunking logic.
- RAG Pipeline: Extracts context and synthesizes responses using XML-tagged prompts.
- OpenRouter LLM: Uses `chatWithOpenRouter()` to call models like `claude-3-haiku`.

---

## Directory Structure

```
customer_service_js/
│
├── index.js                  # Main server & RTMS WebSocket handler
├── ragPipeline.js            # Main RAG logic: load docs, split, embed, query
├── chatWithOpenrouter.js     # Handles OpenRouter LLM calls
│
├── loaders/
│   ├── index.js              # Aggregates all loaders
│   ├── loadPDF.js
│   ├── loadMD.js
│   ├── loadDOCX.js
│   └── loadTXT.js
│
├── langchain/
│   ├── embedUtils.js         # splitDocuments(), createRetriever()
│   └── contextualQA.js       # (optional chaining logic, if used)
│
└── docs/                     # Place support documents here
```

---

## Environment Variables

Create a `.env` file:

```env
PORT=3000
ZOOM_SECRET_TOKEN=your_zoom_token
ZM_CLIENT_ID=your_zoom_client_id
ZM_CLIENT_SECRET=your_zoom_client_secret
WEBHOOK_PATH=/webhook
OPENROUTER_API_KEY=your_openrouter_key
```

---

## Getting Started

```bash
npm install
node index.js
```

Zoom will connect via webhook and stream transcript + media into the system. The backend uses:

- `preloadRetrieverOnce()` to load and split documents
- `askLLMWithTranscript(transcript)` to retrieve context and generate a response

---

## Prompt Format (XML-style)

Prompt sent to LLMs:

```xml
<scenario>
  <role>customer_support</role>
  <input>
    <transcript>...</transcript>
    <context>...</context>
  </input>
  <instruction>
    Use the context to answer the customer's question from the transcript.
    Your answer should be helpful, concise, and formatted in bullet points.
  </instruction>
</scenario>
```

---

## Debug Tips

- Use `console.log()` in `askLLMWithTranscript()` to trace input, context, and final prompt.
- Confirm document files are loaded correctly from `./docs`.
- Ensure retriever returns meaningful results before invoking the LLM.

---

