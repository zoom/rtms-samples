import { connectRabbitMq, createConfirmChannel } from '../shared/rabbitmq.js';
import { parseArgs } from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const amqpUrl = args.amqpUrl || process.env.RABBITMQ_URL || 'amqp://rtms:rtms_password@127.0.0.1:5672/rtms';
const queue = args.queue || process.env.RABBITMQ_TEST_QUEUE || 'rtms.start.region.iad';
const keep = args.keep === true || args.keep === 'true';
const connection = await connectRabbitMq(amqpUrl, { label: 'test rabbitmq connect' });

try {
  const channel = await createConfirmChannel(connection);
  const message = await channel.get(queue, { noAck: false });

  if (!message) {
    console.log(JSON.stringify({ queue, message: null }, null, 2));
    await channel.close();
    process.exit(0);
  }

  const content = JSON.parse(message.content.toString('utf8'));
  if (keep) {
    channel.nack(message, false, true);
  } else {
    channel.ack(message);
  }

  console.log(JSON.stringify({
    queue,
    keptInQueue: keep,
    routingKey: message.fields.routingKey,
    messageId: message.properties.messageId,
    idempotencyKey: message.properties.headers?.idempotencyKey,
    content
  }, null, 2));

  await channel.close();
} finally {
  await connection.close();
}
