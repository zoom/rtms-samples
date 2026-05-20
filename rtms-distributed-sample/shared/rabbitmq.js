import amqp from 'amqplib';
import { isTransientError } from './errors.js';
import { retryWithBackoff } from './retry.js';

export async function connectRabbitMq(url, options = {}) {
  return retryWithBackoff(() => amqp.connect(url, options.connectOptions), {
    label: options.label || 'rabbitmq connect',
    maxAttempts: options.maxAttempts || 5,
    baseDelayMs: options.baseDelayMs || 250,
    maxDelayMs: options.maxDelayMs || 10000,
    shouldRetry: isTransientError
  });
}

export async function createConfirmChannel(connection, options = {}) {
  const channel = await connection.createConfirmChannel();
  if (options.prefetch) {
    await channel.prefetch(options.prefetch);
  }
  return channel;
}

export function publishJson(channel, exchange, routingKey, message, options = {}) {
  const body = Buffer.from(JSON.stringify(message));
  const publishOptions = {
    contentType: 'application/json',
    deliveryMode: 2,
    persistent: true,
    timestamp: Math.floor(Date.now() / 1000),
    messageId: message.idempotencyKey || options.messageId,
    headers: {
      idempotencyKey: message.idempotencyKey,
      schemaVersion: message.schemaVersion,
      ...(options.headers || {})
    }
  };

  return retryWithBackoff(() => new Promise((resolve, reject) => {
    channel.publish(exchange, routingKey, body, publishOptions, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
  }), {
    label: options.label || `rabbitmq publish ${exchange}:${routingKey}`,
    maxAttempts: options.maxAttempts || 5,
    baseDelayMs: options.baseDelayMs || 250,
    maxDelayMs: options.maxDelayMs || 5000,
    shouldRetry: isTransientError
  });
}

export function consumeJson(channel, queue, handler, options = {}) {
  return channel.consume(queue, async (message) => {
    if (!message) return;

    try {
      const payload = JSON.parse(message.content.toString('utf8'));
      await handler(payload, message);
      channel.ack(message);
    } catch (error) {
      const retryable = options.requeueTransient === true && isTransientError(error);
      channel.nack(message, false, retryable);
      if (options.onError) {
        options.onError(error, message, { retryable });
      }
    }
  }, {
    noAck: false,
    consumerTag: options.consumerTag
  });
}
