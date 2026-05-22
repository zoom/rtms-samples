import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

export class KubernetesJobLauncher {
  constructor(options = {}) {
    this.kubectlPath = options.kubectlPath || process.env.KUBECTL_PATH || 'kubectl';
    this.kubeconfig = options.kubeconfig || process.env.KUBECONFIG || null;
    this.kubeconfigInlineB64 = options.kubeconfigInlineB64 || process.env.KUBECONFIG_INLINE_B64 || null;
    this.inlineKubeconfigPath = null;
    this.namespace = options.namespace || process.env.K8S_NAMESPACE || 'rtms';
  }

  async ensureNamespace() {
    const result = await this.kubectl(['get', 'namespace', this.namespace], { allowFailure: true });
    if (result.code === 0) return { created: false, namespace: this.namespace };

    await this.kubectl(['create', 'namespace', this.namespace]);
    return { created: true, namespace: this.namespace };
  }

  async launchJob(options = {}) {
    const streamId = options.streamId || `test-${Date.now()}`;
    const jobName = options.jobName || buildKubernetesJobName(streamId, options.prefix);
    const envelopeSecretName = options.envelope
      ? options.envelopeSecretName || `${jobName}-envelope`
      : options.envelopeSecretName || null;
    if (options.envelope) {
      await this.applyManifest(buildEnvelopeSecretManifest({
        namespace: this.namespace,
        secretName: envelopeSecretName,
        envelope: options.envelope,
        labels: {
          app: 'rtms-compute',
          'rtms.zoom/sample': 'distributed',
          'rtms.zoom/job-name': jobName
        }
      }));
    }

    const manifest = buildJobManifest({
      ...options,
      namespace: this.namespace,
      jobName,
      envelopeSecretName,
      streamId
    });

    const result = await this.applyManifest(manifest);
    if (envelopeSecretName) {
      await this.attachSecretToJob(envelopeSecretName, jobName);
    }

    return {
      jobName,
      envelopeSecretName,
      namespace: this.namespace,
      manifest,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async waitForJobComplete(jobName, timeoutSeconds = 60) {
    return this.kubectl([
      '-n',
      this.namespace,
      'wait',
      '--for=condition=complete',
      `job/${jobName}`,
      `--timeout=${timeoutSeconds}s`
    ]);
  }

  async getJob(jobName) {
    const result = await this.kubectl(['-n', this.namespace, 'get', 'job', jobName, '-o', 'json']);
    return JSON.parse(result.stdout);
  }

  async logs(jobName) {
    const result = await this.kubectl(['-n', this.namespace, 'logs', `job/${jobName}`]);
    return result.stdout;
  }

  async deleteJob(jobName) {
    return this.kubectl(['-n', this.namespace, 'delete', 'job', jobName, '--ignore-not-found=true']);
  }

  async deleteSecret(secretName) {
    return this.kubectl(['-n', this.namespace, 'delete', 'secret', secretName, '--ignore-not-found=true']);
  }

  async attachSecretToJob(secretName, jobName) {
    const job = await this.getJob(jobName);
    const ownerReference = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      name: job.metadata.name,
      uid: job.metadata.uid
    };
    return this.kubectl([
      '-n',
      this.namespace,
      'patch',
      'secret',
      secretName,
      '--type=merge',
      '-p',
      JSON.stringify({
        metadata: {
          ownerReferences: [ownerReference]
        }
      })
    ]);
  }

  async applyManifest(manifest) {
    return this.kubectl(['apply', '-f', '-'], {
      input: JSON.stringify(manifest)
    });
  }

  async kubectl(args, options = {}) {
    const env = { ...process.env };
    const kubeconfig = this.kubeconfig || this.getInlineKubeconfigPath();
    if (kubeconfig) env.KUBECONFIG = kubeconfig;

    return runCommand(this.kubectlPath, args, {
      env,
      input: options.input,
      allowFailure: options.allowFailure
    });
  }

  getInlineKubeconfigPath() {
    if (!this.kubeconfigInlineB64) return null;
    if (this.inlineKubeconfigPath) return this.inlineKubeconfigPath;

    const hash = crypto
      .createHash('sha256')
      .update(this.kubeconfigInlineB64)
      .digest('hex')
      .slice(0, 16);
    const filePath = path.join(os.tmpdir(), `rtms-kubeconfig-${hash}.yaml`);
    const content = Buffer.from(this.kubeconfigInlineB64, 'base64').toString('utf8');

    fs.writeFileSync(filePath, content, { mode: 0o600 });
    this.inlineKubeconfigPath = filePath;
    return filePath;
  }
}

export function buildKubernetesJobName(streamId, prefix = 'rtms') {
  const hash = crypto.createHash('sha256').update(String(streamId)).digest('hex').slice(0, 24);
  return `${sanitizeKubernetesName(prefix)}-${hash}`;
}

function buildJobManifest(options = {}) {
  const image = options.image || process.env.K8S_COMPUTE_IMAGE || process.env.K8S_TEST_IMAGE || 'busybox:1.36';
  const shouldUseImageEntrypoint = options.useImageEntrypoint ?? (
    process.env.K8S_USE_IMAGE_ENTRYPOINT === 'true' ||
    Boolean(process.env.K8S_COMPUTE_IMAGE && !options.command && !options.args)
  );
  const secretName = options.secretName || process.env.K8S_COMPUTE_SECRET_NAME || null;
  const secretMountPath = options.secretMountPath || process.env.K8S_COMPUTE_SECRET_MOUNT_PATH || null;
  const serviceAccountName = options.serviceAccountName || process.env.K8S_COMPUTE_SERVICE_ACCOUNT || null;
  const cpuRequest = options.cpuRequest || process.env.K8S_COMPUTE_CPU_REQUEST || '1';
  const memoryRequest = options.memoryRequest || process.env.K8S_COMPUTE_MEMORY_REQUEST || '4Gi';
  const cpuLimit = options.cpuLimit || process.env.K8S_COMPUTE_CPU_LIMIT || '2';
  const memoryLimit = options.memoryLimit || process.env.K8S_COMPUTE_MEMORY_LIMIT || '8Gi';
  const envelopeSecretName = options.envelopeSecretName || null;
  const envelopeFilePath = options.envelopeFilePath || '/var/run/rtms/envelope.json';
  const envelopeRef = options.envelopeRef || `regional-store:/streams/${encodeURIComponent(options.streamId)}`;
  const command = shouldUseImageEntrypoint ? undefined : options.command || ['sh', '-c'];
  const commandArgs = shouldUseImageEntrypoint ? undefined : options.args || [
    [
      'echo "busybox RTMS launch test"',
      'echo "stream=$RTMS_STREAM_ID region=$REGION_CODE envelope_ref=$RTMS_ENVELOPE_REF"',
      'date -u',
      'sleep 3'
    ].join('; ')
  ];
  const labels = {
    app: shouldUseImageEntrypoint ? 'rtms-compute' : 'rtms-compute-test',
    'rtms.zoom/sample': 'distributed',
    ...normalizeLabelMap(options.labels)
  };
  const volumeMounts = [];
  const volumes = [];

  if (envelopeSecretName) {
    volumeMounts.push({
      name: 'rtms-envelope',
      mountPath: '/var/run/rtms',
      readOnly: true
    });
    volumes.push({
      name: 'rtms-envelope',
      secret: {
        secretName: envelopeSecretName
      }
    });
  }

  if (secretName && secretMountPath) {
    volumeMounts.push({
      name: 'rtms-compute-secrets',
      mountPath: secretMountPath,
      readOnly: true
    });
    volumes.push({
      name: 'rtms-compute-secrets',
      secret: {
        secretName
      }
    });
  }

  const regionCode = options.regionCode || process.env.SPOKE_REGION || process.env.REGION_CODE || 'test';
  const container = {
    name: 'rtms-compute',
    image,
    imagePullPolicy: options.imagePullPolicy || 'IfNotPresent',
    resources: {
      requests: {
        cpu: String(cpuRequest),
        memory: String(memoryRequest)
      },
      limits: {
        cpu: String(cpuLimit),
        memory: String(memoryLimit)
      }
    },
    env: normalizeEnv({
      RTMS_STREAM_ID: options.streamId,
      RTMS_ENVELOPE_FILE: envelopeSecretName ? envelopeFilePath : '',
      RTMS_ENVELOPE_REF: envelopeRef,
      RTMS_SECRET_DIR: secretMountPath || '',
      REGION_CODE: regionCode,
      SPOKE_REGION: regionCode,
      REGIONAL_STORE_URL: options.regionalStoreUrl || process.env.REGIONAL_STORE_URL || '',
      CENTRAL_STORE_URL: options.centralStoreUrl || process.env.CENTRAL_STORE_URL || '',
      ...(options.env || {})
    }),
    volumeMounts: volumeMounts.length > 0 ? volumeMounts : undefined,
    ...(secretName ? { envFrom: [{ secretRef: { name: secretName } }] } : {})
  };

  if (command) {
    container.command = command;
  }

  if (commandArgs) {
    container.args = commandArgs;
  }

  const podSpec = {
    restartPolicy: 'Never',
    terminationGracePeriodSeconds: Number(options.terminationGracePeriodSeconds ?? 30),
    containers: [container]
  };

  if (serviceAccountName) {
    podSpec.serviceAccountName = serviceAccountName;
  }

  if (volumes.length > 0) {
    podSpec.volumes = volumes;
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: options.jobName,
      namespace: options.namespace,
      labels
    },
    spec: {
      backoffLimit: Number(options.backoffLimit ?? 0),
      ttlSecondsAfterFinished: Number(options.ttlSecondsAfterFinished ?? 300),
      template: {
        metadata: { labels },
        spec: podSpec
      }
    }
  };
}

function buildEnvelopeSecretManifest(options = {}) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: options.secretName,
      namespace: options.namespace,
      labels: normalizeLabelMap(options.labels)
    },
    type: 'Opaque',
    stringData: {
      'envelope.json': JSON.stringify(options.envelope, null, 2)
    }
  };
}

function normalizeEnv(values) {
  return Object.entries(values)
    .filter(([_name, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: String(value) }));
}

function normalizeLabelMap(values = {}) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      sanitizeLabelKey(key),
      sanitizeLabelValue(value)
    ])
  );
}

function sanitizeKubernetesName(value) {
  const sanitized = String(value || 'rtms')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return sanitized || 'rtms';
}

function sanitizeLabelKey(value) {
  return String(value || 'label')
    .replace(/[^A-Za-z0-9_.\\/-]+/g, '-')
    .slice(0, 63);
}

function sanitizeLabelValue(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .slice(0, 63);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) {
        resolve(result);
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} failed with code ${code}: ${stderr || stdout}`);
      error.result = result;
      reject(error);
    });

    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
}
