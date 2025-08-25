// kvs_putmedia_producer.js
'use strict';

const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const https = require('https');
const dotenv = require('dotenv');

const { KinesisVideo } = require('@aws-sdk/client-kinesis-video');
const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { HttpRequest } = require('@aws-sdk/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');

dotenv.config();

const REGION = process.env.AWS_REGION;
const STREAM_NAME = process.env.STREAM_NAME;
const MAX_RETRIES = 5;

let lastFragmentTimecodeMs = 0; // track persisted timecodes

// raw inputs
const audioIn = new PassThrough();
const videoIn = new PassThrough();

let ffmpegProcess = null;

/**
 * Build ffmpeg args:
 * - Input #0: PCM16 mono @ 16kHz (pipe:3)
 * - Input #1: H.264 (pipe:4)
 * - Output: Matroska (pipe:1), AAC+H264
 */
function buildFfmpegArgs(offsetSeconds) {
  return [
    '-y', '-nostdin', '-loglevel', 'info',
    '-fflags', '+genpts',

    // AUDIO (pipe:3)
    '-thread_queue_size', '4096',
    '-itsoffset', offsetSeconds.toString(),
    '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:3',

    // VIDEO (pipe:4)
    '-thread_queue_size', '4096',
    '-itsoffset', offsetSeconds.toString(),
    '-f', 'h264', '-r', '25', '-i', 'pipe:4',

    // Keep timing
    '-filter:a', 'aresample=async=1',


    // Map inputs: [1] video, [0] audio
    '-map', '1:v:0', '-map', '0:a:0',

    // Pass video through (don’t re-encode)
    '-c:v', 'copy',

    // Encode audio AAC @ 16kHz mono
    '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1',

    // Fragment settings
    '-f', 'matroska',
    '-cluster_time_limit', '2000',      // 2s max cluster
    '-cluster_size_limit', '5242880',   // 5 MB max cluster
    'pipe:1'
  ];
}

function startFFmpeg() {
  if (ffmpegProcess && !ffmpegProcess.killed) {
    console.warn('[FFmpeg] already running, killing old process');
    try { ffmpegProcess.kill('SIGTERM'); } catch {}
  }

  const offsetSeconds = (lastFragmentTimecodeMs + 100) / 1000;
  console.log(`[FFmpeg] Starting with itsoffset=${offsetSeconds}s`);

  const ff = spawn('ffmpeg', buildFfmpegArgs(offsetSeconds), {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
  });

  ff.stderr.on('data', d => console.warn('[ffmpeg]', d.toString().trim()));
  ff.on('close', code => console.log('[ffmpeg] exited with', code));

  ffmpegProcess = ff;

  audioIn.pipe(ff.stdio[3]);
  videoIn.pipe(ff.stdio[4]);

  const body = new PassThrough();
  ff.stdout.pipe(body);
  return body;
}

async function getPutMediaEndpoint() {
  const kv = new KinesisVideo({ region: REGION, credentials: defaultProvider() });
  const { DataEndpoint } = await kv.getDataEndpoint({
    APIName: 'PUT_MEDIA', StreamName: STREAM_NAME
  });
  return new URL('/putMedia', DataEndpoint);
}

async function startPutMediaOnce(readableBody) {
  const endpoint = await getPutMediaEndpoint();
  const signer = new SignatureV4({
    service: 'kinesisvideo', region: REGION,
    credentials: defaultProvider(), sha256: Sha256
  });

  const req = new HttpRequest({
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port,
    method: 'POST',
    path: endpoint.pathname,
    headers: {
      host: endpoint.host,
      'x-amzn-stream-name': STREAM_NAME,
      'x-amzn-fragment-timecode-type': 'ABSOLUTE',
      'x-amzn-producer-start-timestamp': new Date().toISOString(),
      'transfer-encoding': 'chunked',
      'content-type': 'application/octet-stream',
      'connection': 'keep-alive',
    },
    body: readableBody,
  });

  const signed = await signer.sign(req);
  const handler = new NodeHttpHandler({
    requestTimeout: 0, connectionTimeout: 0, socketTimeout: 0,
    httpsAgent: new https.Agent({ keepAlive: true }),
  });

  const { response } = await handler.handle(signed);
  console.log('[PutMedia] HTTP', response.statusCode, response.statusMessage);

  let partial = '';
  response.body.on('data', chunk => {
    const text = partial + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    partial = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let root;
      try { root = JSON.parse(s); } catch { continue; }
      const ack = root.Acknowledgement || root;
      const evt = ack.EventType;
      const tc = ack.FragmentTimecode;
      const err = ack.ErrorId || ack.ErrorCode;
      console.log('[ACK]', evt, 'tc=', tc, 'err=', err || '(none)');

      if (evt === 'PERSISTED' && typeof tc === 'number') {
        if (tc > lastFragmentTimecodeMs) lastFragmentTimecodeMs = tc;
      }
      if (evt === 'ERROR') {
        response.body.destroy(new Error(`KVS ACK ERROR: ${err}`));
        return;
      }
    }
  });

  return new Promise((resolve, reject) => {
    response.body.on('end', () => resolve());
    response.body.on('error', reject);
  });
}

async function startPutMediaWithRetry(attempt = 1) {
  if (attempt > MAX_RETRIES) {
    console.error('[PutMedia] giving up after retries');
    return;
  }

  const body = startFFmpeg();
  try {
    await startPutMediaOnce(body);
  } catch (err) {
    console.error(`[PutMedia] attempt ${attempt} failed:`, err?.message || err);
    if (ffmpegProcess && !ffmpegProcess.killed) {
      try { ffmpegProcess.kill('SIGTERM'); } catch {}
    }
    const backoff = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
    await new Promise(r => setTimeout(r, backoff));
    return startPutMediaWithRetry(attempt + 1);
  }
}

// Public API
async function startStream() {
  return startPutMediaWithRetry(1);
}

function stopStream() {
  audioIn.end();
  videoIn.end();
  if (ffmpegProcess && !ffmpegProcess.killed) {
    ffmpegProcess.kill('SIGTERM');
  }
  console.log('[KVS] Stopped.');
}

function sendAudioBuffer(buffer) {
  if (buffer?.length) audioIn.write(buffer);
}

function sendVideoBuffer(buffer) {
  if (buffer?.length) videoIn.write(buffer);
}

module.exports = { startStream, stopStream, sendAudioBuffer, sendVideoBuffer };
