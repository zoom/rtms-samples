/**
 * Turn the service's stop decision into the artifact action it implies.
 *
 * Stop reason 8 (`stream_revoked`) has `purge: true`; the dashboard already raises a critical
 * alert from that same `stream_stopped` event. This reconciler completes the operational loop:
 * delete the artifacts for the revoked stream and record each confirmation.
 */
export function createArtifactReconciler({
  listArtifacts = () => [],
  deleteArtifact,
  trace = null,
  now = Date.now
} = {}) {
  if (typeof deleteArtifact !== 'function') throw new Error('deleteArtifact must be a function');

  async function reconcileStop({ stream, decision }) {
    if (!decision?.purge) return { purged: false, reason: 'purge_not_required', deleted: [] };
    const artifacts = await listArtifacts(stream);
    trace?.append('artifact_purge_started', {
      streamId: stream.streamId, meetingId: stream.meetingId, tenantId: stream.tenantId ?? null,
      count: artifacts.length, stopCode: decision.code, at: now()
    });
    const deleted = [];
    for (const artifact of artifacts) {
      await deleteArtifact(artifact, { stream, decision });
      deleted.push(artifact);
      trace?.append('artifact_deleted', {
        streamId: stream.streamId, meetingId: stream.meetingId, tenantId: stream.tenantId ?? null,
        artifact, stopCode: decision.code, at: now()
      });
    }
    trace?.append('artifact_purge_completed', {
      streamId: stream.streamId, meetingId: stream.meetingId, tenantId: stream.tenantId ?? null,
      count: deleted.length, stopCode: decision.code, at: now()
    });
    return { purged: true, reason: 'stream_revoked', deleted };
  }

  return { reconcileStop };
}
