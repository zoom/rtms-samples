import crypto from 'node:crypto';

export const MANIFEST_SCHEMA_VERSION = 1;
export const RTMS_PROTOCOL_VERSION = 1;
export const ARTIFACT_WRITER_VERSION = '1';
export const PARTICIPANT_SCHEMA_VERSION = '1';

/** Stable JSON: keys sorted at every level, so the same parameters always hash the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hashMediaParams = (params) => crypto.createHash('sha256').update(canonicalJson(params)).digest('hex');

/**
 * Artifact-layer id for an immutable chunk. Reprocessing the same bytes gives the same id.
 *   sha256(tenant + meeting + stream + media type + canonical timestamp + bytes)
 */
export function chunkId({ tenantId, meetingId, streamId, mediaType, timestamp, bytes }) {
  return crypto.createHash('sha256').update([tenantId, meetingId, streamId, mediaType, String(timestamp)].join('|')).update('|').update(bytes).digest('hex');
}

/** Natural key for a final artifact. Do not deduplicate by meeting UUID alone. */
export const finalArtifactId = ({ tenantId, meetingId, artifactType, streamGeneration }) => [tenantId, meetingId, artifactType, `gen${streamGeneration}`].join('/');

/** The playbook's minimum stream manifest, plus what a reader needs to trust the capture. */
export function buildStreamManifest({ envelope, mediaParams, segments, gaps, reconnects, stop, degraded, stats, phases, extra = {} }) {
  return {
    tenant_id: envelope.tenantId ?? null,
    meeting_id: envelope.meetingId,
    stream_id: envelope.streamId,
    stream_generation: envelope.generation ?? 1,
    previous_stream_id: envelope.previousStreamId ?? null,
    product: envelope.product ?? 'meeting',
    schema_version: MANIFEST_SCHEMA_VERSION,
    rtms_protocol_version: RTMS_PROTOCOL_VERSION,
    media_params_hash: hashMediaParams(mediaParams),
    participant_schema_version: PARTICIPANT_SCHEMA_VERSION,
    artifact_writer_version: ARTIFACT_WRITER_VERSION,
    policy_version: envelope.policyVersion ?? null,
    consent_ref: envelope.consentRef ?? null,
    stop: stop ? { code: stop.code, name: stop.name, restart: stop.restart, purge: Boolean(stop.purge) } : null,
    degraded: Boolean(degraded),
    requires_new_generation: Boolean(stop && stop.restart !== 'none') || Boolean(degraded && stop),
    segments,
    gaps,
    reconnects,
    stats,
    phases,
    ...extra
  };
}
