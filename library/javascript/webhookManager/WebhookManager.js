import express from 'express';
import { EventEmitter } from 'events';
import { FileLogger } from './utils/FileLogger.js';
import {
  buildUrlValidationResponse,
  captureRawBody,
  verifyZoomWebhookRequest
} from './zoomWebhookSignature.js';

export class WebhookManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.app = options.app || null;
    this.logger = options.logger || FileLogger;
  }

  setup() {
    if (!this.app) {
      this.logger.warn('[WebhookManager] ⚠️ No Express app provided. Skipping webhook setup.');
      return;
    }

    this.app.use(this.config.webhookPath, express.json({ verify: captureRawBody }));
    this.app.post(
      this.config.webhookPath,
      this.handleWebhook.bind(this)
    );
    this.logger.info(`[WebhookManager] 🎣 Webhook route set up at ${this.config.webhookPath}`);
  }

  async handleWebhook(req, res) {
    const body = req.body || {};
    const { event, payload } = body;

    const secretToken = req.query?.type === 'video'
      ? this.config.videoSecretToken
      : this.config.zoomSecretToken;

    if (event !== 'endpoint.url_validation') {
      const verification = verifyZoomWebhookRequest(req, secretToken, {
        toleranceSeconds: this.config.webhookTimestampToleranceSeconds ??
          process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
      });
      if (!verification.ok) {
        const status = verification.reason === 'missing_webhook_secret_token' ? 500 : 401;
        this.logger.warn(`[WebhookManager] Rejected webhook: ${verification.reason}`);
        return res.status(status).json({ error: 'invalid_zoom_webhook' });
      }
    }

    // URL validation requires a JSON response. All normal events are acknowledged
    // before logging or emitting so downstream RTMS work cannot delay Zoom's 200.
    if (event !== 'endpoint.url_validation') {
      res.once('finish', () => {
        setImmediate(() => {
          try {
            this.processWebhookEvent(event, payload, req.headers, body);
          } catch (error) {
            this.logger.error('[WebhookManager] Deferred event processing failed:', error);
          }
        });
      });
      res.status(200).end();
      return;
    }

    this.logger.log('[WebhookManager] Webhook headers:', req.headers);
    this.logger.log('[WebhookManager] Full webhook body:', JSON.stringify(body, null, 2));
    this.logger.log('[WebhookManager] Webhook event:', event);

    if (payload?.plainToken) {
      this.logger.log('[WebhookManager] Webhook request query:', req.query);
      if (!secretToken) {
        return res.status(500).json({ error: 'webhook_secret_not_configured' });
      }
      const response = buildUrlValidationResponse(payload.plainToken, secretToken);
      this.logger.log('[WebhookManager] Webhook validation response:', response);
      return res.json(response);
    }

    return res.sendStatus(400);
  }

  processWebhookEvent(event, payload, headers, body) {
    this.logger.log('[WebhookManager] Webhook headers:', headers);
    this.logger.log('[WebhookManager] Full webhook body:', JSON.stringify(body, null, 2));
    this.logger.log('[WebhookManager] Webhook event:', event);

    if (typeof event !== 'string' || event.length === 0) {
      this.logger.warn('[WebhookManager] Ignoring webhook without a valid event name');
      return;
    }

    if (
      event === 'rtms.concurrency_limited' ||
      event === 'rtms.concurrency_near_limit' ||
      event === 'rtms.start_failed' ||
      event.endsWith('rtms_interrupted')
    ) {
      this.logger.warn(`[WebhookManager] ⚠️ Critical RTMS event received: ${event}`, JSON.stringify(payload, null, 2));
    }
    else if (
      event.endsWith('rtms_started') || event.endsWith('rtms_stopped')
    ) {
      this.logger.log(`[WebhookManager] RTMS event received: ${event}`, JSON.stringify(payload, null, 2));
    }

    this.emit('event', event, payload);
  }
}

export default WebhookManager;
