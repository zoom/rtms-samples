import fetch from 'node-fetch';
import {
  buildDummyRtmsWebhook,
  getStopEvent,
  parseArgs,
  signZoomWebhook
} from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const target = args.target || process.env.WEBHOOK_TEST_URL || 'http://127.0.0.1:4000/webhook';
const region = args.region || process.env.WEBHOOK_TEST_REGION || 'IAD';
const event = args.event || 'meeting.rtms_started';
const streamId = args.streamId || `dummy-stream-${Date.now()}`;
const rtmsId = args.rtmsId || `dummy-rtms-${Date.now()}`;
const secret = args.secret || process.env.WEBHOOK_TEST_SECRET || process.env.ZOOM_SECRET_TOKEN || 'secret';
const sendStop = args.sendStop === true || args.sendStop === 'true';
const stopDelayMs = Number(args.stopDelayMs || 500);

await send(event);

if (sendStop) {
  await sleep(stopDelayMs);
  await send(getStopEvent(event));
}

async function send(currentEvent) {
  const body = buildDummyRtmsWebhook({
    event: currentEvent,
    region,
    streamId,
    rtmsId
  });
  const bodyText = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json'
  };

  const signed = signZoomWebhook(bodyText, secret);
  headers['x-zm-request-timestamp'] = signed.timestamp;
  headers['x-zm-signature'] = signed.signature;

  const response = await fetch(target, {
    method: 'POST',
    headers,
    body: bodyText
  });
  const text = await response.text();

  console.log(JSON.stringify({
    target,
    event: currentEvent,
    region,
    streamId,
    status: response.status,
    response: text || null,
    signed: true,
    signatureHeader: headers['x-zm-signature']
  }, null, 2));

  if (!response.ok && response.status !== 202 && response.status !== 204) {
    process.exitCode = 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
