# 📝 Industry Notetaking App (Zoom RTMS Integration)

## Overview

This application is a real-time meeting transcription and intelligence system designed to integrate with Zoom via its RTMS (Real-Time Media Streaming) API. It captures audio, video, screen shares, and transcripts, then uses NLP pipelines to extract key insights such as:

- Named entities
- Action items
- Meeting topics
- Summary
- Embeddings (optional)

## 📦 Tech Stack

- **Node.js** with `express` for server and API
- **WebSocket** for real-time streaming and frontend updates
- **Zoom RTMS Webhook** integration
- **Custom NLP modules**: NER, topic classification, summarization, etc.
- **Environment variables** via `dotenv`
- **Audio/video handling** with buffer processing

## 🛠 Features

### ✅ Zoom Integration

- Handles webhook events:
  - `endpoint.url_validation`
  - `meeting.rtms_started`
  - `meeting.rtms_stopped`
- Manages secure RTMS WebSocket connections

### 📡 Media WebSocket Stream

- Processes:
  - Audio frames
  - Video frames
  - Deskshare (screen share) frames
  - Transcript text
  - Chat messages (basic support)

### 🧠 NLP Intelligence Pipeline

For every transcript snippet:
- Named entity recognition (`detectEntities`)
- Action item detection (`detectActionItems`)
- Topic classification (`classifyTopic`)
- Meeting summarization (`summarize`)
- (Optional) Embedding generation (`generateEmbedding`)

### 💾 Media Handling

- Detects and saves media types:
  - JPEG
  - PNG
  - H.264 video
- Skips small/initial frames for noise reduction

### 🔄 Real-time Frontend Sync

- Uses WebSocket server on `/ws` path
- Broadcasts updates (transcript, summary, action items) to all connected frontend clients

## 📁 Folder Structure (Simplified)

```plaintext
project-root/
│
├── public/                # Static frontend files
├── recordings/            # Media output (images, videos)
├── nlp/                   # NLP modules
│   ├── ner.js
│   ├── actionItems.js
│   ├── topicClassifier.js
│   ├── summarizer.js
│   └── embedder.js
├── .env                   # Environment variables
├── index.js               # Main application
```

## 🔐 Environment Variables (`.env`)

```env
PORT=3000
ZOOM_SECRET_TOKEN=your_secret_token
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
WEBHOOK_PATH=/webhook
```

## 🚀 Running the App

```bash
npm install
node index.js
```

App will be accessible at:

- Web server: `http://localhost:3000`
- WebSocket: `ws://localhost:3000/ws`
- Zoom Webhook: `http://localhost:3000/webhook`

## 🧪 Example NLP Payload

```json
{
  "type": "transcript",
  "content": {
    "transcript": "We should schedule the product launch next week.",
    "summary": "Discussion on scheduling the product launch.",
    "actionItems": ["Schedule product launch"],
    "topic": "Project Management",
    "entities": ["product launch", "next week"]
  },
  "user": "Alice",
  "timestamp": 1712345678901
}
```

## 🧹 Cleanup & Shutdown

- Closes WebSocket connections on `meeting.rtms_stopped`
- Deletes connection references to avoid memory leaks

## 🧠 Future Enhancements

- Speaker diarization
- Sentiment analysis
- Persistent database storage
- Better frontend dashboard (UI/UX)
- Embedding-powered search & retrieval
