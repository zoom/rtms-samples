#  Zoom RTMS Trait Analyzer

This project captures **real-time audio and transcript data** from Zoom meetings using **Zoom's RTMS API**, then:

- Transcribes audio in real-time
- Analyzes transcript text using an LLM to extract personality/communication traits
- Streams results to the frontend over WebSocket
- Displays cumulative trait scores using a live D3.js bar chart

---

##  Features

-  Real-time audio, video, and transcript ingestion via Zoom RTMS
-  Trait analysis via OpenRouter LLMs (e.g. LLaMA, Claude)
-  Frontend with live-updating D3.js visualization
-  WebSocket bridge between RTMS backend and browser
-  Clean Express + WebSocket architecture

---

##  Setup Instructions

### 1. Clone the repo

```bash
git clone https://github.com/yourusername/zoom-rtms-traits.git
cd zoom-rtms-traits
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create `.env` file

```bash
cp .env.example .env
```

Then fill in the following values:

```env
PORT=3000
OPENROUTER_API_KEY=your_openrouter_api_key
DEFAULT_OPENROUTER_MODEL=meta-llama/llama-4-scout:free

ZM_CLIENT_ID=your_zoom_client_id
ZM_CLIENT_SECRET=your_zoom_client_secret
ZOOM_SECRET_TOKEN=your_zoom_verification_token
WEBHOOK_PATH=/webhook
```

### 4. Download frontend dependencies

Manually download:

- [`d3.v7.min.js`](https://d3js.org/d3.v7.min.js)
- Zoom `sdk.js` (from Zoom SDK)

And place them in:

```
/public/lib/
   d3.v7.min.js
   sdk.js
```

### 5. Run the server

```bash
node server.js
```

This will:

- Serve the frontend on [http://localhost:3000](http://localhost:3000)
- Expose WebSocket at `ws://localhost:3000/ws`
- Handle Zoom RTMS webhook at `http://localhost:3000/webhook`

---

##  How It Works

1. Zoom sends transcript events to your webhook.
2. The server routes data through `extractAndAccumulateTraits()` which:
   - Sends transcript lines to OpenRouter LLMs
   - Extracts 5 communication traits: Curiosity, Empathy, Assertiveness, Creativity, Analytical
   - Accumulates trait scores session-wide
3. The server broadcasts updates to connected frontend clients.
4. The frontend renders a live bar chart using D3.js.

---

##  Testing

You can manually test the frontend by visiting:

```
http://localhost:3000
```

And simulating WebSocket messages to `/ws` using tools like Postman or WebSocket clients.

---

