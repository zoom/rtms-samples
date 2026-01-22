import express from 'express';
import { EventEmitter } from 'events';
import { FileLogger } from './utils/FileLogger.js';

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

    this.app.use(express.json());
    this.app.post(
      this.config.webhookPath,
      this.handleWebhook.bind(this)
    );
    this.logger.info(`[WebhookManager] 🎣 Webhook route set up at ${this.config.webhookPath}`);
  }

  async handleWebhook(req, res) {
    this.logger.log('[WebhookManager] Webhook headers:', req.headers);
    this.logger.log('[WebhookManager] Full webhook body:', JSON.stringify(req.body, null, 2));
    const { event, payload } = req.body;
    this.logger.log('[WebhookManager] Webhook event:', event);

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

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
      this.logger.log('[WebhookManager] Webhook request query:', req.query);
      const crypto = await import('crypto');
      const secretToken = req.query.type === 'video' ? this.config.videoSecretToken : this.config.zoomSecretToken;
      const hash = crypto.createHmac('sha256', secretToken)
        .update(payload.plainToken)
        .digest('hex');
      const response = { plainToken: payload.plainToken, encryptedToken: hash };
      this.logger.log('[WebhookManager] Webhook validation response:', response);
      return res.json(response);
    }
    res.sendStatus(200);

    this.emit('event', event, payload);
  }
}

export default WebhookManager;
