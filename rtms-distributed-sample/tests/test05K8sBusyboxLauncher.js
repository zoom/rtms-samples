import { KubernetesJobLauncher } from '../shared/kubernetesJobLauncher.js';
import { buildEnvelope } from '../shared/envelope.js';
import { buildDummyRtmsWebhook, parseArgs } from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const kubeconfig = args.kubeconfig || process.env.KUBECONFIG;
const namespace = args.namespace || process.env.K8S_NAMESPACE || 'rtms';
const image = args.image || process.env.K8S_TEST_IMAGE || 'busybox:1.36';
const streamId = args.streamId || `busybox-${Date.now()}`;
const keep = args.keep === true || args.keep === 'true';

if (!kubeconfig) {
  throw new Error('Set KUBECONFIG or pass --kubeconfig /path/to/k3s-remote.yaml');
}

const launcher = new KubernetesJobLauncher({ kubeconfig, namespace });
const webhook = buildDummyRtmsWebhook({ region: args.region || 'IAD', streamId });
const envelope = buildEnvelope(webhook.event, webhook.payload, 'test05-k8s-busybox', webhook);

await launcher.ensureNamespace();
console.log(`PASS namespace_ready namespace=${namespace}`);

const launched = await launcher.launchJob({
  streamId,
  envelope,
  image,
  prefix: 'rtms-busybox',
  regionCode: args.region || 'test',
  args: [
    [
      'echo "hello from busybox"',
      'echo "stream=$RTMS_STREAM_ID"',
      'echo "region=$REGION_CODE"',
      'echo "envelope_ref=$RTMS_ENVELOPE_REF"',
      'echo "envelope_file=$RTMS_ENVELOPE_FILE"',
      'test -f "$RTMS_ENVELOPE_FILE"',
      'grep -q "$RTMS_STREAM_ID" "$RTMS_ENVELOPE_FILE"',
      'echo "envelope_secret_verified"',
      'date -u',
      'sleep 3'
    ].join('; ')
  ]
});
console.log(`PASS job_submitted job=${launched.jobName} image=${image}`);

await launcher.waitForJobComplete(launched.jobName, Number(args.timeoutSeconds || 60));
console.log(`PASS job_completed job=${launched.jobName}`);

const logs = await launcher.logs(launched.jobName);
if (!logs.includes('hello from busybox') || !logs.includes(streamId) || !logs.includes('envelope_secret_verified')) {
  throw new Error(`Unexpected job logs: ${logs}`);
}
console.log('PASS job_logs_verified');
console.log(logs.trim());

if (!keep) {
  await launcher.deleteJob(launched.jobName);
  console.log(`PASS job_deleted job=${launched.jobName}`);
  await launcher.deleteSecret(launched.envelopeSecretName);
  console.log(`PASS envelope_secret_deleted secret=${launched.envelopeSecretName}`);
}

console.log('05 k8s busybox launcher tester passed');
