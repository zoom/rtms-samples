
# Zoom RTMS WebSocket C++ Client

This project demonstrates how to connect to Zoom's Real-Time Media Service (RTMS) using C++. It establishes WebSocket connections to the Zoom Event server, Signaling server, and Media server, handling authentication, heartbeats, and media payloads like YUV420 video and PCM audio.

---

## 📦 Requirements

Ensure you have the following dependencies installed:

### 🧰 Libraries

- `websocketpp` – WebSocket client
- `boost` – Asio integration for WebSocket++
- `OpenSSL` – TLS support & HMAC-SHA256 for signature generation
- `nlohmann/json` – JSON parsing and construction
- `libcurl` – For HTTP access token request
- `dotenv` (optional) – `.env` loader (custom `load_env` used)


### 📦 Install on Ubuntu

```bash
sudo apt update
sudo apt install libboost-all-dev libssl-dev libcurl4-openssl-dev cmake build-essential
```

---

## 📁 Project Structure

```bash
.
├── CMakeLists.txt
├── main.cpp
├── include/
│   ├── utils.h
│   ├── signaling_ws.h
│   └── media_ws.h
├── src/
│   ├── utils.cpp
│   ├── signaling_ws.cpp
│   └── media_ws.cpp
├── external/
│   └── websocketpp/
├── .env
└── bin/
    └── ZoomWebSocketClient
```

---

## 🔨 Build Instructions

```bash
cmake -B build
cmake --build build
./bin/ZoomWebSocketClient
```

> Ensure your `.env` file is present in the root directory.

---

## 📄 .env Format

```ini
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
ZOOM_EVENT_WS=wss://ws.zoom.us/ws?subscriptionId=abc123
```

---

## 🧬 Flow Overview

1. **Connect to Event WebSocket** (Zoom sends RTMS start event)
2. **Wait for `meeting.rtms_started`**
3. **Extract `meeting_uuid`, `stream_id`, and `server_urls`**
4. **Connect to Signaling WebSocket**
   - Send handshake with HMAC signature
   - Wait for `msg_type = 2`
   - Extract media server URL
5. **Connect to Media WebSocket**
   - Send media handshake
   - On success, stream begins
   - Respond to keep-alive messages
6. **Decode audio/video if desired**

---

## 🔐 Access Token (OAuth2)

Access tokens are retrieved using client credentials via libcurl.

### ⚠️ Empty POST Body Required

Zoom's token URL expects a POST with an empty body. This must be explicitly set in C++:

```cpp
curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "");
```

Failing to do this results in the connection hanging indefinitely.

---

## 💡 JSON in C++

All JSON is handled with `nlohmann::json`:

```cpp
#include "nlohmann/json.hpp"
using json = nlohmann::json;
```

You can easily serialize/deserialize:

```cpp
json j = json::parse(payload_str);
std::string stream_id = j["payload"]["rtms_stream_id"];
```

---

## Websocket in  C++

This project uses WebSocket++, a C++ header-only library for client and server WebSocket implementations.
WebSocket++ is included as a Git submodule or manually downloaded into the external/ directory.

```
mkdir -p external/
cd external/
git clone https://github.com/zaphoyd/websocketpp.git
```

In additon to the modules above, it is included in CMakeLists.txt
WebSocket++ is header-only, you don't need to compile it — just include its headers.

```
target_include_directories(ZoomWebSocketClient
    PRIVATE
    external/websocketpp
)
```

## 🫀 Heartbeat Support

Each WebSocket (event, signaling, media) supports heartbeats.

- A JSON heartbeat: `{ "module": "heartbeat" }`
- Sent every 30 seconds using a detached thread
- Must be sent **after** connection is established (`on_open` handler)

### Example:

```cpp
std::thread([&c, hdl]() {
    while (true) {
        std::this_thread::sleep_for(std::chrono::seconds(30));
        json heartbeat = {{"module", "heartbeat"}};
        c.send(hdl, heartbeat.dump(), websocketpp::frame::opcode::text);
    }
}).detach();
```

---

## 📤 Media Payloads

Media server sends messages with `msg_type`:

- `14` – Audio data (PCM)
- `15` – Video data (YUV420)
- `17` – Transcription

You can capture and process these for further use.

---

## 🧪 Development Tips

- Use `CURLOPT_VERBOSE` to debug curl issues.
- Use `set_open_handler`, `set_message_handler` in WebSocket++ to manage lifecycle.
- Make sure you use TLS (`wss://`) and provide correct handshake headers.

---



## ✅ Done

- [x] Token handling
- [x] Event-to-signal-to-media chaining
- [x] Media handshake + streaming
- [x] Heartbeat thread support
- [x] JSON payload parsing

---

## Acknowledgements

This project depends on the excellent work of the open source community:

nlohmann/json
Header-only JSON library for modern C++.
Used for all JSON parsing and serialization.

WebSocket++
C++ WebSocket client/server implementation.
Used to connect securely to Zoom’s WebSocket endpoints.

libcurl
Multiprotocol client-side URL transfer library.
Used for sending OAuth token requests to Zoom’s REST API.

OpenSSL
Secure Sockets Layer toolkit.
Used for both WebSocket TLS (WSS) and for generating HMAC SHA-256 signatures used in signaling/media handshakes.

Boost
Required for WebSocket++’s Asio transport.
Used for event loop and asynchronous handling.