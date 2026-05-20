import assert from 'node:assert/strict';
import { verifyZoomWebhookRequest } from '../shared/zoomSignature.js';
import { buildDummyRtmsWebhook, signZoomWebhook } from './dummyRtms.js';

const secret = 'test-secret';
const bodyText = JSON.stringify(buildDummyRtmsWebhook({
  event: 'meeting.rtms_started',
  region: 'IAD',
  streamId: 'test-stream',
  rtmsId: 'test-meeting'
}));
const signed = signZoomWebhook(bodyText, secret);

assert.equal(verifyZoomWebhookRequest(mockRequest(bodyText, signed), secret).ok, true);
assert.equal(
  verifyZoomWebhookRequest(mockRequest(bodyText, signed), 'wrong-secret').reason,
  'invalid_x_zm_signature'
);
assert.equal(
  verifyZoomWebhookRequest(mockRequest(bodyText, signZoomWebhook(bodyText, secret, 1)), secret).reason,
  'stale_x_zm_request_timestamp'
);
assert.equal(
  verifyZoomWebhookRequest(mockRequest(bodyText, {}), secret).reason,
  'missing_x_zm_signature'
);

console.log('Zoom webhook signature verification tests passed');

function mockRequest(rawBody, signedHeaders) {
  return {
    rawBody: Buffer.from(rawBody),
    headers: {
      'x-zm-request-timestamp': signedHeaders.timestamp,
      'x-zm-signature': signedHeaders.signature
    }
  };
}
