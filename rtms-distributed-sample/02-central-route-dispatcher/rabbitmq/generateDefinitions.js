import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_REGIONS = Object.freeze([
  'SJC',
  'IAD',
  'AMS',
  'FRA',
  'MEL',
  'SYD',
  'YYZ',
  'SIN',
  'NRT',
  'HKG'
]);

const DEFAULT_OUT = path.resolve('02-central-route-dispatcher/rabbitmq/definitions.json');
const START_MESSAGE_TTL_MS = 60000;

if (isCli()) {
  const args = parseArgs(process.argv.slice(2));
  const regions = normalizeRegions(args.regions || process.env.RTMS_REGIONS || DEFAULT_REGIONS.join(','));
  const outputPath = path.resolve(args.out || process.env.RABBITMQ_DEFINITIONS_OUT || DEFAULT_OUT);
  const definitions = buildDefinitions({
    regions,
    vhost: process.env.RABBITMQ_VHOST || 'rtms'
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(definitions, null, 2)}\n`);

  console.log(`Wrote ${outputPath}`);
  console.log(`Regions: ${definitions.metadata.regions.join(', ')}`);
}

export function buildDefinitions({ regions, vhost }) {
  const normalizedRegions = normalizeRegions(regions);
  const queues = [
    queue('rtms.webhooks.inbox'),
    ...normalizedRegions.flatMap((region) => {
      const lower = region.toLowerCase();
      return [
        queue(`rtms.start.region.${lower}`, {
          messageTtlMs: START_MESSAGE_TTL_MS,
          deadLetterRoutingKey: `start.expired.region.${lower}`
        }),
        queue(`rtms.stop.region.${lower}`),
        queue(`rtms.recovery.region.${lower}`)
      ];
    }),
    queue('rtms.warning.start_expired', { deadLetter: false }),
    queue('rtms.dead_letter', { deadLetter: false })
  ];

  const bindings = [
    bind('rtms.ingress', 'rtms.webhooks.inbox', 'webhook.received'),
    ...normalizedRegions.flatMap((region) => {
      const lower = region.toLowerCase();
      return [
        bind('rtms.webhooks', `rtms.start.region.${lower}`, `start.region.${lower}`),
        bind('rtms.webhooks', `rtms.stop.region.${lower}`, `stop.region.${lower}`),
        bind('rtms.webhooks', `rtms.recovery.region.${lower}`, `recovery.region.${lower}`)
      ];
    }),
    bind('rtms.dead', 'rtms.warning.start_expired', 'start.expired.#'),
    bind('rtms.dead', 'rtms.dead_letter', '#')
  ];

  return {
    metadata: {
      generatedBy: '02-central-route-dispatcher/rabbitmq/generateDefinitions.js',
      regions: normalizedRegions,
      startMessageTtlMs: START_MESSAGE_TTL_MS
    },
    vhosts: [
      {
        name: vhost
      }
    ],
    exchanges: [
      exchange('rtms.ingress', vhost),
      exchange('rtms.webhooks', vhost),
      exchange('rtms.dead', vhost)
    ],
    queues: queues.map((item) => ({ ...item, vhost })),
    bindings: bindings.map((item) => ({ ...item, vhost }))
  };
}

export function normalizeRegions(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const regions = input
    .map((item) => String(item).trim().toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(regions));
  if (!unique.includes('UNKNOWN')) unique.push('UNKNOWN');
  return unique;
}

function exchange(name, vhost) {
  return {
    name,
    vhost,
    type: 'topic',
    durable: true,
    auto_delete: false,
    internal: false,
    arguments: {}
  };
}

function queue(name, options = {}) {
  const args = {
    'x-queue-type': 'quorum'
  };

  if (options.deadLetter !== false) {
    args['x-dead-letter-exchange'] = 'rtms.dead';
  }

  if (options.deadLetterRoutingKey) {
    args['x-dead-letter-routing-key'] = options.deadLetterRoutingKey;
  }

  if (options.messageTtlMs) {
    args['x-message-ttl'] = options.messageTtlMs;
  }

  return {
    name,
    vhost: 'rtms',
    durable: true,
    auto_delete: false,
    arguments: args
  };
}

function bind(source, destination, routingKey) {
  return {
    source,
    vhost: 'rtms',
    destination,
    destination_type: 'queue',
    routing_key: routingKey,
    arguments: {}
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--regions') {
      parsed.regions = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--regions=')) {
      parsed.regions = arg.slice('--regions='.length);
    } else if (arg === '--out') {
      parsed.out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      parsed.out = arg.slice('--out='.length);
    }
  }
  return parsed;
}

function isCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
