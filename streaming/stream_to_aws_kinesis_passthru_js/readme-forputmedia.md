# 📄 README — KVS PutMedia FFmpeg Producer

This script (`kvs_putmedia_producer.js`) captures raw PCM audio + H.264 video streams, re-encodes them via FFmpeg, and pushes them to **AWS Kinesis Video Streams (KVS)** using the `PutMedia` API.  

It is designed for **real-time live streaming** scenarios and ensures **timecode continuity** across reconnects to avoid `KVS ACK ERROR: 4004` (“fragment timecode is less than the last persisted timecode”).  

---

## 🚀 How it works

1. **Inputs**  
   - Audio: `pcm_s16le` 16kHz mono, via a Node `PassThrough` stream.
   - Video: H.264 Annex-B (with start codes), via a Node `PassThrough` stream.

2. **FFmpeg**  
   - Combines audio & video into an MKV stream.  
   - Forces PTS reset on first start, then offsets timestamps after reconnects.  
   - Re-encodes video to H.264 (`libx264`) and audio to AAC for KVS.

3. **PutMedia API**  
   - Uses AWS SDK v3 low-level HTTP calls with `SignatureV4` signing.  
   - Sends MKV stream as a `chunked` HTTP POST to the KVS `PUT_MEDIA` endpoint.  
   - Monitors `ACK` responses to detect persistence or errors.

4. **Error handling & retries**  
   - Tracks last persisted fragment timestamp from `ACK` messages.  
   - On reconnect, starts FFmpeg with an `-itsoffset` so time never goes backwards.  
   - Retries with exponential backoff.

---

## 📦 Installation

```bash
npm install   @aws-sdk/client-kinesis-video   @aws-sdk/protocol-http   @aws-sdk/signature-v4   @aws-sdk/credential-provider-node   @aws-crypto/sha256-js   @aws-sdk/node-http-handler   dotenv
```

You also need `ffmpeg` installed and available in your `PATH`:

```bash
sudo apt-get install ffmpeg
# or
brew install ffmpeg
```

---

## ⚙️ Environment variables

Create a `.env` file:

```ini
AWS_REGION=us-east-1
STREAM_NAME=my-kvs-stream
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

---

## 🖥 Usage

```js
const { startStream, stopStream, sendAudioBuffer, sendVideoBuffer } = require('./kvs_putmedia_producer');

(async () => {
  await startStream();

  // Example: send audio & video buffers periodically
  setInterval(() => {
    sendAudioBuffer(getPcmAudioChunk());
    sendVideoBuffer(getH264VideoChunk());
  }, 40); // ~25fps

  process.on('SIGINT', stopStream);
})();
```

---

## 🛠 Gotchas (Learned the Hard Way)

1. **4004 errors = timecode jumps backwards**  
   - If KVS sees a fragment with a timecode less than the last persisted fragment, it throws `4004`.
   - Fix: Track last `PERSISTED` fragment’s timecode and restart FFmpeg with an offset.

2. **Use `ABSOLUTE` timecode type**  
   - In request headers:
     ```js
     'x-amzn-fragment-timecode-type': 'ABSOLUTE'
     ```
     This makes KVS trust the MKV timestamps instead of resetting to “upload start”.

3. **Start offset on reconnect**  
   - Pass `-itsoffset` to FFmpeg inputs based on the last persisted timestamp + a small buffer (~100ms).  
   - Prevents accidental overlap.

4. **Avoid sending stale first buffers**  
   - Do **not** replay first audio/video chunks from before a reconnect — they might have old PTS.  
   - Write directly into FFmpeg after restart.

5. **One FFmpeg per session**  
   - Don’t keep FFmpeg running across failed PutMedia connections — restart it fresh so timestamps and muxing state reset.

6. **Chunked MKV output**  
   - Use Matroska with small clusters:
     ```
     -f matroska -cluster_time_limit 1000 -cluster_size_limit 0
     ```
     Keeps latency low and prevents giant fragments.

7. **Thread queue size**  
   - Set `-thread_queue_size 4096` on both audio & video inputs to avoid frame drops if Node’s write rate is uneven.

8. **PTS debugging**  
   - Use:
     ```
     -loglevel debug -debug_ts
     ```
     to see FFmpeg’s internal timestamps and confirm continuity.

---

## 📊 Debugging
- To see ACKs:
  ```
  [ACK] PERSISTED tc= 123456 num= 913438523331816xxxx err= (none)
  ```
- If you see `ERROR` with `4004`, check whether your next FFmpeg session is starting **before** that `tc` in milliseconds.

---


change audio to 20ms