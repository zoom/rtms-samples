import { createGenerationIndex } from '../../60-stream-lifecycle-client/src/generations.js';
import { startLiveSession } from '../../60-stream-lifecycle-client/src/liveSession.js';
import { silentLogger } from '../../shared/log.js';

/**
 * Connects the start service to real RTMS streams.
 *
 *   onStreamReady   a verified, claimed stream: open signaling and media to Zoom
 *   onStreamRefresh Zoom replaced the RTMS server and sent a new started webhook for the same
 *                   stream: move the sockets to the new server URLs, do not open a second stream
 *   onStreamStopped a stop webhook arrived: finalize with its reason
 *
 * When a session ends for any reason it releases the claim, so lease renewal stops and a late
 * duplicate started webhook cannot reopen the stream.
 */
export function createLiveBridge({ credentials, config, trace, log = silentLogger, getService, startSession = startLiveSession, generations = createGenerationIndex(), artifactReconciler = null }) {
  const sessions = new Map();

  function onStreamReady(stream) {
    const meetingKey = `${stream.tenantId}|${stream.product}|${stream.meetingId}`;
    const generation = generations.register(meetingKey, stream.streamId);
    // A throw here reaches the start service, which abandons the claim and alerts.
    const session = startSession({ stream, credentials, config, trace, log, generation });
    sessions.set(stream.streamId, session);
    session.done
      .then((result) => generations.close(meetingKey, stream.streamId, result.manifest.degraded ? 'finalized_degraded' : 'finalized'))
      .catch((error) => log.error('live session failed', { streamId: stream.streamId, error: error.message }))
      .finally(() => {
        sessions.delete(stream.streamId);
        getService()?.releaseStream(stream.streamId, 'client_finished');
      });
  }

  function onStreamRefresh(stream, started) {
    const session = sessions.get(stream.streamId);
    if (!session) return { applied: false, reason: 'no_session' };
    const result = session.client.refresh(started.serverUrls);
    log.info('started webhook refreshed a live stream', { streamId: stream.streamId, ...result });
    return result;
  }

  function onStreamStopped(stream, decision) {
    const session = sessions.get(stream.streamId);
    session?.client.finalize(decision.code, 'stop_webhook');
    // Reason 8 (stream revoked) purges the artifacts, even when the session is already gone:
    // the release path runs before this webhook in the usual race. Wait for the manifest write
    // when a session is finishing; act at once when there is none.
    if (decision?.purge && artifactReconciler) {
      const purge = () => artifactReconciler.reconcileStop({ stream, decision })
        .catch((error) => log.error('artifact purge failed', { streamId: stream.streamId, error: error.message }));
      if (session?.done) Promise.resolve(session.done).then(purge, purge);
      else purge();
    }
  }

  /** Close every live stream with STREAM_CLOSE_REQ so Zoom does not wait on keep-alives. */
  async function shutdown(timeoutMs = 1500) {
    await Promise.all([...sessions.values()].map((s) => s.client.close(timeoutMs)));
  }

  return { onStreamReady, onStreamRefresh, onStreamStopped, shutdown, sessions, generations };
}
