import { buildEnvelope } from '../shared/envelope.js';
import { connectRabbitMq, createConfirmChannel, publishJson } from '../shared/rabbitmq.js';
import { buildDummyRtmsWebhook, deriveRoutingKey, parseArgs } from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const amqpUrl = args.amqpUrl || process.env.RABBITMQ_URL || 'amqp://rtms:rtms_password@127.0.0.1:5672/rtms';
const exchange = args.exchange || process.env.RABBITMQ_WEBHOOK_EXCHANGE || 'rtms.webhooks';
const event = args.event || 'meeting.rtms_started';
const region = args.region || process.env.WEBHOOK_TEST_REGION || 'IAD';
const streamId = args.streamId || `dummy-stream-${Date.now()}`;
const rtmsId = args.rtmsId || `dummy-rtms-${Date.now()}`;

const webhook = buildDummyRtmsWebhook({ event, region, streamId, rtmsId });
const envelope = buildEnvelope(webhook.event, webhook.payload, 'queue-test');
const routingKey = args.routingKey || deriveRoutingKey(envelope, region);
const connection = await connectRabbitMq(amqpUrl, { label: 'test rabbitmq connect' });

try {
  const channel = await createConfirmChannel(connection);
  await publishJson(channel, exchange, routingKey, envelope, {
    label: `test publish ${routingKey}`
  });

  console.log(JSON.stringify({
    exchange,
    routingKey,
    event: envelope.event,
    regionCode: envelope.regionCode,
    streamId: envelope.streamId,
    idempotencyKey: envelope.idempotencyKey
  }, null, 2));

  await channel.close();
} finally {
  await connection.close();
}
