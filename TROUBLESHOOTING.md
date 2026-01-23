# Troubleshooting

## Webhook Issues

### Duplicate Webhook Events

**Symptom**: Your app receives the same webhook event multiple times (e.g., multiple `meeting.rtms_started` for the same meeting), typically ~5 minutes apart.

**Cause**: Zoom expects a `200 OK` response to acknowledge webhook receipt. If your endpoint doesn't respond with 200, Zoom treats it as a failure and retries the webhook.

**Solution**: Always respond with `res.status(200)` (or equivalent) immediately upon receiving any webhook, before processing:

```javascript
// Express.js example
app.post('/webhook', (req, res) => {
  // ACK immediately - Zoom requires 200 response
  res.status(200).send('OK');
  
  // Then process the event asynchronously
  processWebhook(req.body);
});
```

```python
# Flask example
@app.route('/webhook', methods=['POST'])
def webhook():
    # ACK immediately
    data = request.json
    
    # Process asynchronously (e.g., queue it)
    process_webhook.delay(data)
    
    return 'OK', 200
```

**Important**: If you don't have idempotency checks in place, duplicate webhooks can cause issues like:
- Multiple RTMS connections to the same meeting
- Duplicate recordings
- Race conditions in your application logic

Add idempotency checks using the `meeting_uuid` or event `event_ts` to detect and ignore duplicates.

## Connection Issues

### WebSocket Closes with Code 1000 (Normal Closure)

**Symptom**: Signaling WebSocket connection closes shortly with code `1000` after connecting.

**Common Causes**:

1. **Invalid Signature**: The HMAC signature in your handshake request is incorrect.
   - Verify you're using the correct `ZOOM_CLIENT_SECRET`
   - Ensure the signature algorithm matches Zoom's requirements (HMAC-SHA256)
   - Check that you're signing the correct payload

2. **Failure to Respond to Server Messages**: Zoom sends messages that require a response. If your client doesn't respond in time, the server times out and closes the connection.

   **Important**: Some WebSocket libraries don't handle all message types by default. You must listen for both text AND binary messages.

   ```java
   // Java example - MUST listen for binary messages explicitly
   webSocket.addListener(new WebSocketAdapter() {
       @Override
       public void onTextMessage(WebSocket ws, String text) {
           // Handle text messages
           handleMessage(text);
       }
       
       @Override
       public void onBinaryMessage(WebSocket ws, byte[] binary) {
           // CRITICAL: Zoom may send binary frames
           // Convert and handle, or connection will timeout
           String text = new String(binary, StandardCharsets.UTF_8);
           handleMessage(text);
       }
   });
   ```

   ```python
   # Python websockets - handle both message types
   async for message in websocket:
       if isinstance(message, bytes):
           message = message.decode('utf-8')
       handle_message(json.loads(message))
   ```

   **Note**: Node.js WebSocket libraries (like `ws`) typically handle this automatically, but other languages may require explicit binary message handling.

### General Connection Checklist

- Verify ngrok/tunnel is running and accessible
- Check Zoom OAuth credentials in `.env`
- Ensure webhook URL is correctly configured in Zoom Marketplace

## No Audio/Video Data

- **RTMS not triggered yet**: The RTMS stream must be explicitly started via one of these methods:
  - Auto-start (if configured in Zoom app settings)
  - REST API call to start RTMS
  - Other triggers (e.g., meeting host action)
  
  If none of these have occurred, no `meeting.rtms_started` webhook will be sent and no media will flow.
- Verify RTMS is enabled for your app (Zoom web settings)
- Check that your app has correct RTMS scopes
- Ensure you're handling the `meeting.rtms_started` webhook event

## FFmpeg Conversion Issues

- RTMS audio: L16 PCM at 16kHz/24kHz, mono
- FFmpeg params: `-f s16le -ar 16000 -ac 1`
- Ensure FFmpeg is installed and in PATH

## SDK Installation

```bash
npm install github:zoom/rtms
```

Ensure you have the correct token for fetching prebuilt binaries.

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid signature` | Wrong client secret | Verify `ZOOM_CLIENT_SECRET` in `.env` |
| `401 Unauthorized` | Expired/invalid credentials | Regenerate credentials in Marketplace |
| `WebSocket closed` | Network interruption | RTMSManager auto-reconnects; check network |
| `ECONNRESET` | Server closed connection | Check server logs; increase timeouts |
