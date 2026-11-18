import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeWebhookEndpoint } from './src/probes.js';
import { urlValidationResponse, verifyWebhook } from '../shared/webhookSignature.js';

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/webhook`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function validatingServer(serverSecret) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const verified = verifyWebhook({ headers: req.headers, rawBody, secret: serverSecret });
      if (!verified.ok) {
        res.writeHead(401).end();
        return;
      }
      const body = JSON.parse(rawBody.toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(urlValidationResponse(body.payload.plainToken, serverSecret)));
    });
  };
}

test('webhook probe: correct secret validates, wrong secret and bad endpoints are explained', async () => {
  await withServer(validatingServer('right'), async (url) => {
    assert.deepEqual(await probeWebhookEndpoint({ url, secret: 'right' }), { ok: true, reason: 'validated', status: 200 });
    const wrong = await probeWebhookEndpoint({ url, secret: 'wrong' });
    assert.deepEqual([wrong.ok, wrong.status], [false, 401]);
  });
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"plainToken":"x","encryptedToken":"y"}'); }, async (url) => {
    assert.equal((await probeWebhookEndpoint({ url, secret: 's' })).reason, 'plain_token_not_echoed');
  });
  assert.equal((await probeWebhookEndpoint({ url: 'http://127.0.0.1:9/webhook', secret: 's', timeoutMs: 500 })).ok, false);
  assert.equal((await probeWebhookEndpoint({ url: '', secret: 's' })).reason, 'missing_url');
  assert.equal((await probeWebhookEndpoint({ url: 'http://x', secret: '' })).reason, 'missing_secret_token');
});
