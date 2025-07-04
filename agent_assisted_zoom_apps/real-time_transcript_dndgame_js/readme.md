# Real-Time D&D Story Game with Zoom and OpenRouter

This project is a real-time, voice-driven collaborative storytelling game inspired by Dungeons & Dragons. It uses:

- OpenRouter for AI Dungeon Master narration
- Zoom Apps SDK for live meeting context and transcript
- WebSocket server to stream transcripts and narration
- Simple frontend UI (HTML/JS) to show player speech and AI responses

## Features

- Real-time player voice to transcript
- AI Dungeon Master responds to each player action
- Broadcasts story updates to all connected clients
- Fast, lightweight frontend (HTML/JS)

## Project Structure

```
.
├── index.js                # WebSocket + transcript logic
├── dndGame.js              # Game logic and LLM handling
├── openrouterChat.js       # OpenRouter API wrapper
├── public/
│   └── index.html          # Frontend UI
├── .env                    # API keys and config
```

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/yourname/zoom-dnd-game.git
cd zoom-dnd-game
```

### 2. Install dependencies

```bash
npm install openai dotenv ws
```

### 3. Configure environment variables

Create a `.env` file:

```env
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=anthropic/claude-3-haiku
PORT=3000
```

## Run the Server

```bash
node index.js
```

## Frontend Usage

Open `public/index.html` in a browser. It will:

- Display live player transcripts
- Show AI Dungeon Master narration
