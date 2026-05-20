import { DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

const args = parseArgs(process.argv.slice(2));
const children = [];
let shuttingDown = false;

const endpoint = args.endpoint || process.env.ARTIFACT_S3_ENDPOINT || 'http://127.0.0.1:9000';
const accessKeyId = args.accessKey || process.env.AWS_ACCESS_KEY_ID || process.env.MINIO_ROOT_USER || 'rtms_minio';
const secretAccessKey = args.secretKey || process.env.AWS_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || 'rtms_minio_password';
const bucket = args.bucket || `rtms-artifacts-test-${process.pid}`;
const region = args.region || process.env.AWS_REGION || 'us-east-1';
const shouldStartComposeMinio = !args.noCompose && isLoopbackEndpoint(endpoint);

try {
  if (shouldStartComposeMinio) {
    execFileSync('docker', ['compose', 'up', '-d', 'object-storage'], {
      cwd: repoRoot,
      stdio: args.verbose ? 'inherit' : 'ignore'
    });
  }

  await waitForMinio(endpoint, accessKeyId, secretAccessKey, region);
  console.log(`PASS minio_ready endpoint=${endpoint}`);

  const port = await getFreePort();
  const serviceUrl = `http://127.0.0.1:${port}`;
  children.push(spawnService('08-artifact-storage/server.js', {
    ARTIFACT_STORAGE_PORT: String(port),
    ARTIFACT_STORAGE_PROVIDER: 'minio',
    ARTIFACT_BUCKET: bucket,
    AWS_REGION: region,
    ARTIFACT_S3_ENDPOINT: endpoint,
    ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
    ARTIFACT_S3_CREATE_BUCKET: 'true',
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey
  }));

  const health = await waitForJson(`${serviceUrl}/health`, 'artifact storage health');
  assert(health.storage?.provider === 's3-compatible', 'artifact storage did not use S3-compatible provider');
  assert(health.storage?.createBucket === true, 'artifact storage did not enable bucket creation');
  console.log(`PASS artifact_storage_minio_health port=${port}`);

  const streamId = `minio-artifact-stream-${Date.now()}`;
  const markdown = '# MinIO Final Summary\n\nThis is a MinIO artifact test.\n';
  const upload = await postJson(`${serviceUrl}/artifacts`, {
    streamId,
    rtmsId: 'minio-artifact-rtms',
    regionCode: 'SJC',
    productType: 'meeting',
    artifactType: 'summary_final',
    fileName: 'final.md',
    contentType: 'text/markdown',
    content: markdown,
    metadata: {
      test: true,
      provider: 'minio'
    }
  });

  const artifact = upload.artifact;
  assert(artifact.blobUri === `s3://${bucket}/${artifact.objectKey}`, 'unexpected MinIO blobUri');
  assert(artifact.provider === 's3-compatible', 'unexpected provider name');
  assert(artifact.sha256 === sha256(markdown), 'sha mismatch');
  assert(artifact.objectKey.includes('artifact_type=summary_final'), 'object key missing artifact type partition');
  assert(artifact.objectKey.includes(`stream_id=${streamId}`), 'object key missing stream id partition');
  console.log(`PASS minio_artifact_uploaded blobUri=${artifact.blobUri}`);

  const client = createClient(endpoint, accessKeyId, secretAccessKey, region);
  const object = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: artifact.objectKey
  }));
  const body = await streamToString(object.Body);
  assert(body === markdown, 'MinIO object content mismatch');
  console.log(`PASS minio_artifact_downloaded key=${artifact.objectKey}`);

  if (!args.keepBucket) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: artifact.objectKey }));
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    console.log(`PASS minio_bucket_cleaned bucket=${bucket}`);
  }

  console.log('10 MinIO artifact storage tester passed: 4/4');
} finally {
  shuttingDown = true;
  for (const child of children.reverse()) {
    child.kill('SIGTERM');
  }
}

function spawnService(script, env) {
  const child = spawn(process.execPath, [path.join(repoRoot, script)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    if (args.verbose || process.env.TEST_VERBOSE) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (args.verbose || process.env.TEST_VERBOSE) process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[test10] ${script} exited code=${code} signal=${signal || ''}`);
    }
  });
  return child;
}

async function waitForMinio(endpoint, accessKeyId, secretAccessKey, region) {
  const client = createClient(endpoint, accessKeyId, secretAccessKey, region);
  await waitForCondition(async () => {
    try {
      await client.config.credentials();
      const response = await fetch(`${endpoint.replace(/\/+$/, '')}/minio/health/ready`);
      return response.ok;
    } catch (_error) {
      return false;
    }
  }, 'MinIO readiness', 120);
}

function createClient(endpoint, accessKeyId, secretAccessKey, region) {
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, label) {
  return waitForCondition(async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.json();
    } catch (_error) {
      return null;
    }
  }, label);
}

async function waitForCondition(check, label, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${url} failed status=${response.status}: ${await response.text()}`);
  return response.json();
}

async function streamToString(stream) {
  if (typeof stream?.transformToString === 'function') {
    return stream.transformToString();
  }

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-compose') parsed.noCompose = true;
    else if (arg === '--keep-bucket') parsed.keepBucket = true;
    else if (arg === '--verbose') parsed.verbose = true;
    else if (arg.startsWith('--')) {
      parsed[arg.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function isLoopbackEndpoint(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch (_error) {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
