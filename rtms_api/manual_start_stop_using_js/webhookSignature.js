import crypto from 'node:crypto';

export function captureRawBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

export function authenticateZoomWebhook(
  secretToken,
  configuredTolerance = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300)
) {
  const toleranceSeconds = Number.isFinite(configuredTolerance) && configuredTolerance >= 0
    ? configuredTolerance
    : 300;
  return (req, res, next) => {
    if (req.body?.event === 'endpoint.url_validation') return next();
    if (!secretToken) {
      return res.status(500).json({ error: 'webhook_secret_not_configured' });
    }

    const signature = req.headers['x-zm-signature'];
    const timestamp = req.headers['x-zm-request-timestamp'];
    if (!signature || !timestamp || !Buffer.isBuffer(req.rawBody)) {
      return res.status(401).json({ error: 'invalid_zoom_webhook' });
    }

    const timestampSeconds = Number(timestamp);
    if (
      !Number.isFinite(timestampSeconds) ||
      (toleranceSeconds > 0 &&
        Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > toleranceSeconds)
    ) {
      return res.status(401).json({ error: 'invalid_zoom_webhook' });
    }

    const expected = `v0=${crypto
      .createHmac('sha256', secretToken)
      .update(`v0:${timestamp}:${req.rawBody.toString('utf8')}`)
      .digest('hex')}`;
    const receivedBuffer = Buffer.from(String(signature));
    const expectedBuffer = Buffer.from(expected);
    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ error: 'invalid_zoom_webhook' });
    }
    return next();
  };
}
