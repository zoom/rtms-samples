import crypto from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function verifyDelivery(rawBody, headers, secretToken) {
  if (!secretToken) return { ok: false, reason: 'missing_webhook_secret_token' };
  const signature = headers['x-zm-signature'];
  const timestamp = headers['x-zm-request-timestamp'];
  if (!signature) return { ok: false, reason: 'missing_x_zm_signature' };
  if (!timestamp) return { ok: false, reason: 'missing_x_zm_request_timestamp' };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'invalid_x_zm_request_timestamp' };
  }
  const configuredTolerance = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300);
  const toleranceSeconds = Number.isFinite(configuredTolerance) && configuredTolerance >= 0
    ? configuredTolerance
    : 300;
  if (
    toleranceSeconds > 0 &&
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > toleranceSeconds
  ) {
    return { ok: false, reason: 'stale_x_zm_request_timestamp' };
  }

  const expected = `v0=${crypto
    .createHmac('sha256', secretToken)
    .update(`v0:${timestamp}:${rawBody.toString('utf8')}`)
    .digest('hex')}`;
  const receivedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: 'invalid_x_zm_signature' };
  }
  return { ok: true, reason: 'verified' };
}

export function startAuthenticatedWebhookServer(onEvent) {
  const port = Number(process.env.ZM_RTMS_PORT || 8080);
  const path = process.env.ZM_RTMS_PATH || '/';
  const secretToken = process.env.ZM_RTMS_SECRET_TOKEN;

  if (!secretToken) {
    throw new Error('ZM_RTMS_SECRET_TOKEN is required to authenticate Zoom webhooks');
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== path) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      const rawBody = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }

      if (body.event === 'endpoint.url_validation' && body.payload?.plainToken) {
        const encryptedToken = crypto
          .createHmac('sha256', secretToken)
          .update(body.payload.plainToken)
          .digest('hex');
        sendJson(res, 200, { plainToken: body.payload.plainToken, encryptedToken });
        return;
      }

      const verification = verifyDelivery(rawBody, req.headers, secretToken);
      if (!verification.ok) {
        const status = verification.reason === 'missing_webhook_secret_token' ? 500 : 401;
        sendJson(res, status, { error: 'invalid_zoom_webhook' });
        return;
      }

      sendJson(res, 200, { status: 'ok' });
      setImmediate(() => {
        Promise.resolve(onEvent(body)).catch((error) => {
          console.error('[Webhook] Event handler failed:', error);
        });
      });
    });
  });

  server.listen(port, () => {
    console.log(`Authenticated Zoom webhook listening on http://localhost:${port}${path}`);
  });
  return server;
}
