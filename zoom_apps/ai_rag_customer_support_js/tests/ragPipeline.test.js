import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { splitDocuments, createRetriever } from '../langchain/embedUtils.js';
import {
  shouldTriggerAutoRag,
  askLLMWithTranscript,
  setRetrieverForTesting
} from '../ragPipeline.js';
import { chatWithOpenRouter } from '../chatWithOpenrouter.js';
import { SupportSessionStore } from '../supportSessionStore.js';
import {
  decryptZoomAppContext,
  mintWsAuthToken,
  verifyWsAuthToken,
  createAuthorizeRegistration
} from '../wsAuth.js';

function encryptZoomContext(payload, clientSecret) {
  const key = crypto.createHash('sha256').update(clientSecret).digest();
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from('zoom-app-test');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(1 + iv.length + 2 + aad.length + 4 + ciphertext.length + tag.length);
  let offset = 0;
  header.writeUInt8(iv.length, offset); offset += 1;
  iv.copy(header, offset); offset += iv.length;
  header.writeUInt16LE(aad.length, offset); offset += 2;
  aad.copy(header, offset); offset += aad.length;
  header.writeUInt32LE(ciphertext.length, offset); offset += 4;
  ciphertext.copy(header, offset); offset += ciphertext.length;
  tag.copy(header, offset);
  return header.toString('base64');
}

test('splitDocuments attaches accurate source, fileName, chunkIndex, and snippet metadata', async () => {
  const longDoc = Array.from({ length: 12 }, (_, i) =>
    `Section ${i + 1}: Refund requests must be submitted within 30 days of purchase with receipt number.`
  ).join('\n\n');

  const chunks = await splitDocuments([
    { file: '/kb/refund-policy.md', content: longDoc }
  ], { chunkSize: 300, chunkOverlap: 60 });

  assert.ok(chunks.length >= 3);
  chunks.forEach((chunk, idx) => {
    assert.equal(chunk.metadata.source, '/kb/refund-policy.md');
    assert.equal(chunk.metadata.fileName, 'refund-policy.md');
    assert.equal(chunk.metadata.chunkIndex, idx);
    assert.equal(chunk.metadata.totalChunks, chunks.length);
    assert.ok(chunk.metadata.snippet.length > 0);
  });
});

test('BM25/TF-IDF retriever ranks relevant chunks accurately and filters below minScore', async () => {
  const chunks = await splitDocuments([
    {
      file: '/kb/billing.md',
      content: 'Enterprise annual subscriptions include a 30-day full refund window. Contact billing@example.com with your invoice ID to cancel or request a refund.'
    },
    {
      file: '/kb/security.md',
      content: 'All data is encrypted in transit using TLS 1.3 and at rest using AES-256. SOC 2 Type II audit reports are available under NDA.'
    },
    {
      file: '/kb/email-setup.md',
      content: 'To configure Windows Live Mail for your student iChat email account, enter your full student address and enable SSL on port 995.'
    }
  ], { chunkSize: 500, chunkOverlap: 50 });

  const retriever = await createRetriever(chunks, {
    enableRemoteEmbeddings: false,
    minScore: 0.15
  });

  assert.equal(retriever.getStats().mode, 'bm25-tfidf');

  const refundResults = await retriever.getRelevantDocuments('How do I request a refund for my subscription?');
  assert.ok(refundResults.length >= 1);
  assert.equal(refundResults[0].metadata.fileName, 'billing.md');
  assert.ok(refundResults[0].score >= 0.15);

  const securityResults = await retriever.getRelevantDocuments('Do you have SOC 2 compliance and AES-256 encryption?');
  assert.equal(securityResults[0].metadata.fileName, 'security.md');

  const unrelated = await retriever.getRelevantDocuments('xylophone giraffe volcano');
  assert.equal(unrelated.length, 0);
});

test('createRetriever supports hybrid embeddings API and falls back cleanly on HTTP error', async () => {
  const chunks = await splitDocuments([
    { file: '/kb/a.txt', content: 'Resetting two-factor authentication requires admin approval.' },
    { file: '/kb/b.txt', content: 'Shipping takes three business days within the continental US.' }
  ]);

  const mockFetchOk = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.input.map((text, index) => ({
      index,
      embedding: text.toLowerCase().includes('two-factor') || text.toLowerCase().includes('2fa')
        ? [1, 0]
        : [0, 1]
    }));
    return { ok: true, status: 200, json: async () => ({ data }) };
  };

  const hybridRetriever = await createRetriever(chunks, {
    embeddingModel: 'text-embedding-3-small',
    apiKey: 'sk-test-key',
    fetchImpl: mockFetchOk,
    minScore: 0.1
  });
  assert.equal(hybridRetriever.getStats().mode, 'hybrid-embedding');

  const res = await hybridRetriever.getRelevantDocuments('locked out of 2fa');
  assert.equal(res[0].metadata.fileName, 'a.txt');

  // Fallback when API returns 500
  const fallbackRetriever = await createRetriever(chunks, {
    embeddingModel: 'text-embedding-3-small',
    apiKey: 'sk-test-key',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'server error' })
  });
  assert.equal(fallbackRetriever.getStats().mode, 'bm25-tfidf');
});

test('chatWithOpenRouter honors MODEL_ID, checks res.ok, and parses grounded JSON bullets', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevModel = process.env.MODEL_ID;
  process.env.OPENROUTER_API_KEY = 'sk-or-unit-test';
  process.env.MODEL_ID = 'custom/test-model:free';

  try {
    let capturedBody = null;
    const result = await chatWithOpenRouter({
      question: 'What is the refund window?',
      contextDocs: [{ pageContent: '30-day refund policy.', metadata: { fileName: 'billing.md', chunkIndex: 0 } }],
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            model: capturedBody.model,
            choices: [{
              message: {
                content: JSON.stringify({
                  answerBullets: ['Enterprise plans include a 30-day refund window [1].'],
                  confidence: 'high',
                  grounded: true,
                  citedSources: [1]
                })
              }
            }]
          })
        };
      }
    });

    assert.equal(capturedBody.model, 'custom/test-model:free');
    assert.equal(result.confidence, 'high');
    assert.equal(result.grounded, true);
    assert.deepEqual(result.bullets, ['Enterprise plans include a 30-day refund window [1].']);
    assert.deepEqual(result.citedSources, [1]);

    await assert.rejects(
      () => chatWithOpenRouter({
        question: 'Test',
        contextDocs: [],
        fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
      }),
      /OpenRouter HTTP 429/
    );
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.MODEL_ID;
    else process.env.MODEL_ID = prevModel;
  }
});

test('askLLMWithTranscript returns citations and falls back gracefully when LLM errors', async () => {
  const chunks = await splitDocuments([
    { file: '/kb/billing.md', content: 'Annual plans can be refunded within 30 days by emailing billing@example.com.' }
  ]);
  const retriever = await createRetriever(chunks, { enableRemoteEmbeddings: false, minScore: 0.1 });
  setRetrieverForTesting(retriever, [{ fileName: 'billing.md', chunkCount: 1 }]);

  const res = await askLLMWithTranscript('Can I get a refund on my annual plan?', {
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'unavailable' })
  });

  assert.equal(res.grounded, true);
  assert.equal(res.fallbackExtractive, true);
  assert.equal(res.citations.length, 1);
  assert.equal(res.citations[0].fileName, 'billing.md');
  assert.ok(res.bullets.length >= 1);
});

test('shouldTriggerAutoRag filters filler and accepts real customer support questions', () => {
  assert.equal(shouldTriggerAutoRag('Thanks!'), false);
  assert.equal(shouldTriggerAutoRag('Sounds good'), false);
  assert.equal(shouldTriggerAutoRag('Okay, got it.'), false);
  assert.equal(shouldTriggerAutoRag('How do I reset my password?'), true);
  assert.equal(shouldTriggerAutoRag('I am getting an error when configuring my email account'), true);
});

test('SupportSessionStore handles transcript rewind, speaker roles, and cleanup on stop', () => {
  const store = new SupportSessionStore();
  store.registerAgentIdentity('meeting-1', { userId: 'agent-1', userName: 'Dana' });

  const agentTurn = store.applyTranscriptEvent({
    meetingId: 'meeting-1',
    streamId: 'stream-1',
    userId: 'agent-1',
    userName: 'Dana',
    sentenceId: 1,
    text: 'Hi! How can I help you today?'
  });
  assert.equal(agentTurn.turn.role, 'agent');

  const custInitial = store.applyTranscriptEvent({
    meetingId: 'meeting-1',
    streamId: 'stream-1',
    userId: 'cust-1',
    userName: 'Alex',
    sentenceId: 2,
    text: 'How do I set up'
  });
  assert.equal(custInitial.turn.role, 'customer');

  // Rewind update with same sentenceId
  const custRevised = store.applyTranscriptEvent({
    meetingId: 'meeting-1',
    streamId: 'stream-1',
    userId: 'cust-1',
    userName: 'Alex',
    sentenceId: 2,
    isUpdate: true,
    attribute: 2,
    text: 'How do I set up my email account?'
  });
  assert.equal(custRevised.action, 'updated');
  assert.equal(custRevised.turn.id, custInitial.turn.id);
  assert.equal(store.getSnapshot('meeting-1').turns.length, 2);

  // Toggle speaker role
  store.setSpeakerRole('meeting-1', { userId: 'cust-1', role: 'agent' });
  assert.equal(store.resolveRole('meeting-1', { userId: 'cust-1' }), 'agent');

  store.markRtmsStopped('meeting-1', 'stream-1');
  assert.equal(store.getSnapshot('meeting-1').turns.length, 0);
});

test('wsAuth authorizes active RTMS, static token, Zoom App context HMAC token, and rejects unauthorized', async () => {
  const secret = 'test-zoom-client-secret';
  const encrypted = encryptZoomContext({ mid: 'meeting-abc', uid: 'user-1', exp: Date.now() + 60000 }, secret);
  const decrypted = decryptZoomAppContext(encrypted, secret);
  assert.equal(decrypted.mid, 'meeting-abc');

  const token = mintWsAuthToken(decrypted, secret);
  assert.equal(verifyWsAuthToken(token, secret, 'meeting-abc').valid, true);
  assert.equal(verifyWsAuthToken(token, secret, 'other-meeting').valid, false);

  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ meetingUuid: 'active-meeting' }],
    signingSecret: secret,
    env: { FRONTEND_WSS_AUTH_TOKEN: 'static-dev-token' }
  });

  assert.equal((await authorize({ meetingUUID: 'active-meeting', userID: 'u1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'meeting-abc', userID: 'u1', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'any-meeting', userID: 'u1', token: 'static-dev-token' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'unauth-meeting', userID: 'u1', token: 'bad' })).authorized, false);
});
