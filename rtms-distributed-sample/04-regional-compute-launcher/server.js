import dotenv from 'dotenv';
import { installGracefulShutdown } from '../shared/gracefulShutdown.js';
import express from 'express';
import { fireAndForget } from '../shared/http.js';
import { KubernetesJobLauncher, buildKubernetesJobName } from '../shared/kubernetesJobLauncher.js';
import { isInterruptedEvent, isStartEvent, isStopEvent } from '../shared/regions.js';
import { createRtmsObservabilityLogger } from '../shared/rtmsObservabilityLogger.js';

dotenv.config({ override: true });

const app = express();
const port = Number(process.env.COMPUTE_LAUNCHER_PORT || process.env.COMPUTE_PORT || 4710);
const regionCode = process.env.SPOKE_REGION || process.env.REGION_CODE || 'unknown';
const regionalStoreUrl = process.env.REGIONAL_STORE_URL || process.env.CENTRAL_STORE_URL || '';
const centralStoreUrl = process.env.CENTRAL_STORE_URL || regionalStoreUrl;
const computeRegionalStoreUrl = process.env.COMPUTE_REGIONAL_STORE_URL || regionalStoreUrl;
const computeCentralStoreUrl = process.env.COMPUTE_CENTRAL_STORE_URL || centralStoreUrl;
const computeArtifactStorageUrl = process.env.COMPUTE_ARTIFACT_STORAGE_URL || process.env.ARTIFACT_STORAGE_URL || '';
const computeRealtimeCacheUrl = process.env.COMPUTE_REALTIME_CACHE_URL || process.env.REALTIME_CACHE_URL || '';
const jobPrefix = process.env.K8S_JOB_PREFIX || `rtms-${regionCode}`;
const stopJobDeleteDelayMs = Number(process.env.K8S_STOP_JOB_DELETE_DELAY_MS || 25000);
const computeImagePullPolicy = process.env.K8S_IMAGE_PULL_POLICY || (process.env.K8S_COMPUTE_IMAGE ? 'Always' : 'IfNotPresent');
const computeResources = {
  requests: {
    cpu: process.env.K8S_COMPUTE_CPU_REQUEST || '0.25',
    memory: process.env.K8S_COMPUTE_MEMORY_REQUEST || '200Mi'
  },
  limits: {
    cpu: process.env.K8S_COMPUTE_CPU_LIMIT || '0.5',
    memory: process.env.K8S_COMPUTE_MEMORY_LIMIT || '1Gi'
  }
};
const logger = createRtmsObservabilityLogger({
  service: 'regional-compute-launcher',
  regionCode,
  nodeId: process.env.NODE_ID || `compute-launcher-${regionCode}-${process.pid}`,
  level: process.env.SERVICE_LOG_LEVEL || process.env.RTMS_LOG_LEVEL || 'info',
  console: process.env.SERVICE_LOG_CONSOLE !== 'false'
});
const launcher = new KubernetesJobLauncher({
  kubeconfig: process.env.KUBECONFIG,
  namespace: process.env.K8S_NAMESPACE || 'rtms'
});
const localLaunches = [];

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'regional-compute-launcher',
    regionCode,
    port,
    kubernetes: {
      namespace: launcher.namespace,
      kubeconfig: process.env.KUBECONFIG ? 'configured' : 'default',
      image: process.env.K8S_COMPUTE_IMAGE || process.env.K8S_TEST_IMAGE || 'busybox:1.36',
      imagePullPolicy: computeImagePullPolicy,
      credentialSecret: process.env.K8S_COMPUTE_SECRET_NAME || null,
      resources: computeResources
    },
    regionalStoreUrl,
    computeJobStoreUrls: {
      regionalStoreUrl: computeRegionalStoreUrl,
      centralStoreUrl: computeCentralStoreUrl
    },
    computeJobArtifactStorageUrl: computeArtifactStorageUrl || null,
    computeJobRealtimeCacheUrl: computeRealtimeCacheUrl || null,
    computeJobMediaTypesFlag: process.env.MEDIA_TYPES_FLAG || '32',
    jobPrefix,
    stopJobDeleteDelayMs,
    recentLaunches: localLaunches.slice(-20)
  });
});

app.post('/compute/webhook', async (req, res) => {
  const envelope = req.body || {};
  if (!envelope.streamId || !envelope.event) {
    return res.status(400).json({ error: 'missing_event_or_stream_id' });
  }

  res.sendStatus(202);
  handleEnvelope(envelope).catch((error) => {
    logger.error(`[04-regional-compute-launcher] stream=${envelope.streamId} failed: ${error.message}`);
  });
});

async function handleEnvelope(envelope) {
  if (isStopEvent(envelope.event)) {
    const jobName = buildKubernetesJobName(envelope.streamId, jobPrefix);
    const envelopeSecretName = `${jobName}-envelope`;
    remember({
      streamId: envelope.streamId,
      event: envelope.event,
      action: 'kubernetes_job_stop_scheduled',
      jobName,
      stopJobDeleteDelayMs,
      at: new Date().toISOString()
    });
    logger.info(`[04-regional-compute-launcher] stream=${envelope.streamId} stop scheduled -> k8s job=${jobName} delayMs=${stopJobDeleteDelayMs}`);
    setTimeout(() => {
      fireAndForget(deleteStoppedJob(jobName, envelopeSecretName, envelope.streamId), `delete stopped job ${jobName}`);
    }, stopJobDeleteDelayMs).unref();
    return;
  }

  if (!isStartEvent(envelope.event)) {
    remember({
      streamId: envelope.streamId,
      event: envelope.event,
      action: isInterruptedEvent(envelope.event)
        ? 'recovery_event_deferred_to_stream_owner'
        : 'ignored_non_rtms_start',
      at: new Date().toISOString()
    });
    return;
  }

  await launcher.ensureNamespace();
  const launched = await launcher.launchJob({
    streamId: envelope.streamId,
    envelope,
    prefix: jobPrefix,
    image: process.env.K8S_COMPUTE_IMAGE,
    imagePullPolicy: computeImagePullPolicy,
    regionCode,
    regionalStoreUrl: computeRegionalStoreUrl,
    centralStoreUrl: computeCentralStoreUrl,
    secretName: process.env.K8S_COMPUTE_SECRET_NAME,
    secretMountPath: process.env.K8S_COMPUTE_SECRET_MOUNT_PATH,
    serviceAccountName: process.env.K8S_COMPUTE_SERVICE_ACCOUNT,
    cpuRequest: computeResources.requests.cpu,
    memoryRequest: computeResources.requests.memory,
    cpuLimit: computeResources.limits.cpu,
    memoryLimit: computeResources.limits.memory,
    terminationGracePeriodSeconds: Number(process.env.K8S_TERMINATION_GRACE_PERIOD_SECONDS || 60),
    ttlSecondsAfterFinished: Number(process.env.K8S_JOB_TTL_SECONDS_AFTER_FINISHED || 900),
    env: {
      DRY_RUN: process.env.COMPUTE_DRY_RUN || process.env.DRY_RUN || 'false',
      MEDIA_TYPES_FLAG: process.env.MEDIA_TYPES_FLAG || '32',
      MEDIA_SOCKET_CONNECTION_MODE: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
      AUDIO_STREAM_MODE: process.env.AUDIO_STREAM_MODE || 'mixed',
      VIDEO_STREAM_MODE: process.env.VIDEO_STREAM_MODE || 'active',
      ONE_STREAM_PER_JOB: process.env.ONE_STREAM_PER_JOB || 'true',
      ARTIFACT_STORAGE_URL: computeArtifactStorageUrl,
      ARTIFACT_UPLOAD_TIMEOUT_MS: process.env.ARTIFACT_UPLOAD_TIMEOUT_MS || '5000',
      ARTIFACT_UPLOAD_ATTEMPTS: process.env.ARTIFACT_UPLOAD_ATTEMPTS || '2',
      MEDIA_RECORDING_ENABLED: process.env.MEDIA_RECORDING_ENABLED || 'true',
      MEDIA_FINALIZE_DELAY_MS: process.env.MEDIA_FINALIZE_DELAY_MS || '2000',
      WRITE_MEDIA_PACKET_EVENTS: process.env.WRITE_MEDIA_PACKET_EVENTS || 'false',
      REALTIME_CACHE_URL: computeRealtimeCacheUrl,
      REALTIME_CACHE_FLUSH_INTERVAL_MS: process.env.REALTIME_CACHE_FLUSH_INTERVAL_MS || '5000',
      LOKI_PUSH_URL: process.env.COMPUTE_LOKI_PUSH_URL || process.env.LOKI_PUSH_URL || '',
      RTMS_LOG_LEVEL: process.env.RTMS_LOG_LEVEL || 'info',
      RTMS_LOG_CONSOLE: process.env.RTMS_LOG_CONSOLE || 'true'
    },
    labels: {
      'rtms.zoom/region': regionCode,
      'rtms.zoom/stream-id': envelope.streamId
    }
  });

  remember({
    streamId: envelope.streamId,
    event: envelope.event,
    action: 'kubernetes_job_launched',
    jobName: launched.jobName,
    namespace: launched.namespace,
    at: new Date().toISOString()
  });
  logger.info(`[04-regional-compute-launcher] stream=${envelope.streamId} -> k8s job=${launched.jobName} namespace=${launched.namespace}`);
}

async function deleteStoppedJob(jobName, envelopeSecretName, streamId) {
  await launcher.deleteJob(jobName);
  await launcher.deleteSecret(envelopeSecretName);
  remember({
    streamId,
    event: 'kubernetes.job.deleted_after_stop',
    action: 'kubernetes_job_deleted',
    jobName,
    envelopeSecretName,
    at: new Date().toISOString()
  });
  logger.info(`[04-regional-compute-launcher] stream=${streamId} deleted k8s job=${jobName}`);
}

function remember(entry) {
  localLaunches.push(entry);
  if (localLaunches.length > 200) {
    localLaunches.splice(0, localLaunches.length - 200);
  }
}

const server = app.listen(port, () => {
  logger.info(`[04-regional-compute-launcher] ${regionCode} listening on http://127.0.0.1:${port}/compute/webhook`);
});

installGracefulShutdown({ name: 'regional-compute-launcher', server, cleanup: async () => logger.stop?.() });
