import { EVENT_TYPE } from '../../shared/codes.js';

export const PARTICIPANT_SCHEMA_VERSION = '1';

/**
 * Stream-scoped participant registry.
 *
 * Meeting SDK bots often tracked people by display name. That breaks on duplicate names and
 * renames. Here the key is the RTMS user ID, and the registry belongs to ONE stream:
 * tenant + meeting UUID + rtms_stream_id. A new generation gets a new registry.
 *
 * Time is the stream clock (the event and packet timestamps), never the local clock, so
 * intervals line up with the media.
 *
 * It records three kinds of interval per person: presence, video on, and speaking
 * (active speaker). Mixed audio is attributed from the speaking intervals only. Silence
 * is never used to guess a speaker.
 */
export function createParticipantRegistry({ tenantId = null, meetingId, streamId }) {
  const people = new Map();
  const links = new Map(); // Zoom App participant UUID <-> RTMS user ID
  const listeners = new Set();
  let speaking = null; // { userId }

  const notify = (change) => { for (const fn of listeners) fn(change); };

  function person(userId, name, ts, implicit = false) {
    let p = people.get(userId);
    if (!p) {
      p = { userId, name: name ?? null, names: name ? [{ name, from: ts }] : [], roles: [], present: false, implicit, presence: [], video: [], speaking: [] };
      people.set(userId, p);
    }
    return p;
  }
  const open = (list) => list.length > 0 && list.at(-1).to === null;
  const openInterval = (list, ts) => { if (!open(list)) list.push({ from: ts, to: null }); };
  const closeInterval = (list, ts, closedBy) => {
    if (!open(list)) return false;
    list.at(-1).to = ts;
    if (closedBy) list.at(-1).closedBy = closedBy;
    return true;
  };

  function participantsIn(event) {
    if (Array.isArray(event.participants) && event.participants.length) return event.participants;
    if (event.user_id != null) return [{ user_id: event.user_id, user_name: event.user_name }];
    return [];
  }

  /** Feed every participant-related signaling event here. Unrelated events are ignored. */
  function handleEvent(event = {}) {
    const ts = Number(event.timestamp);
    if (!Number.isFinite(ts)) return { handled: false, reason: 'no_timestamp' };
    switch (event.event_type) {
      case EVENT_TYPE.PARTICIPANT_JOIN:
        for (const raw of participantsIn(event)) join(raw.user_id, raw.user_name, ts);
        return { handled: true };
      case EVENT_TYPE.PARTICIPANT_LEAVE:
        for (const raw of participantsIn(event)) leave(raw.user_id, ts);
        return { handled: true };
      case EVENT_TYPE.PARTICIPANT_VIDEO_ON:
        for (const raw of participantsIn(event)) videoOn(raw.user_id, raw.user_name, ts);
        return { handled: true };
      case EVENT_TYPE.PARTICIPANT_VIDEO_OFF:
        for (const raw of participantsIn(event)) videoOff(raw.user_id, ts);
        return { handled: true };
      case EVENT_TYPE.ACTIVE_SPEAKER_CHANGE:
        activeSpeaker(event.user_id, event.user_name, ts);
        return { handled: true };
      default:
        return { handled: false, reason: 'not_a_participant_event' };
    }
  }

  function join(userId, name, ts) {
    if (userId == null) return;
    const p = person(userId, name, ts);
    if (p.present) {
      // Same ID again: a duplicate delivery, a rename, or the join that confirms someone first seen on video.
      if (p.implicit) {
        p.implicit = false;
        if (name && name !== p.name) { p.name = name; p.names.push({ name, from: ts }); }
        notify({ type: 'join', userId });
        return;
      }
      if (name && name !== p.name) {
        p.name = name;
        p.names.push({ name, from: ts });
        notify({ type: 'rename', userId, name });
      }
      return;
    }
    p.present = true;
    p.implicit = false;
    if (name && name !== p.name) { p.name = name; p.names.push({ name, from: ts }); }
    openInterval(p.presence, ts);
    notify({ type: 'join', userId });
  }

  function leave(userId, ts) {
    const p = people.get(userId);
    if (!p || !p.present) return;
    // Leaving ends everything that depended on being present.
    const hadVideo = closeInterval(p.video, ts, 'left');
    closeInterval(p.speaking, ts, 'left');
    closeInterval(p.presence, ts);
    p.present = false;
    if (speaking?.userId === userId) speaking = null;
    if (hadVideo) notify({ type: 'video_off', userId, cause: 'left' });
    notify({ type: 'leave', userId });
  }

  function videoOn(userId, name, ts) {
    if (userId == null) return;
    const p = person(userId, name, ts, true);
    if (!p.present) { p.present = true; openInterval(p.presence, ts); }
    if (!open(p.video)) {
      openInterval(p.video, ts);
      notify({ type: 'video_on', userId });
    }
  }

  function videoOff(userId, ts) {
    const p = people.get(userId);
    if (p && closeInterval(p.video, ts, 'video_off')) notify({ type: 'video_off', userId, cause: 'video_off' });
  }

  function activeSpeaker(userId, name, ts) {
    if (speaking) {
      const prev = people.get(speaking.userId);
      if (prev) closeInterval(prev.speaking, ts, 'speaker_changed');
      speaking = null;
    }
    if (userId == null || userId === 0) return; // nobody is the active speaker
    const p = person(userId, name, ts, true);
    openInterval(p.speaking, ts);
    speaking = { userId };
    notify({ type: 'speaker', userId });
  }

  /** Roles are not carried by the RTMS signaling events in these samples. Feed them from your own source. */
  function setRole(userId, role, ts) {
    const p = people.get(userId);
    if (!p || p.roles.at(-1)?.role === role) return false;
    p.roles.push({ role, from: ts });
    notify({ type: 'role', userId, role });
    return true;
  }

  // --- attribution -----------------------------------------------------------

  const covers = (interval, ts) => ts >= interval.from && (interval.to === null || ts < interval.to);

  /** Mixed audio: who was the active speaker at this timestamp? Unknown stays unknown. */
  function attributeAudio(ts) {
    let best = null;
    for (const p of people.values()) {
      const hit = p.speaking.find((i) => covers(i, ts));
      if (hit && (!best || hit.from > best.from)) best = { userId: p.userId, name: p.name, from: hit.from };
    }
    return best
      ? { userId: best.userId, name: best.name, basis: 'active_speaker_interval' }
      : { userId: null, name: null, basis: 'no_active_speaker' };
  }

  /** Individual video: only frames from someone whose video interval covers the frame. */
  function attributeVideo(userId, ts) {
    const p = people.get(userId);
    return Boolean(p && p.video.some((i) => covers(i, ts)));
  }

  const isVideoOn = (userId) => open(people.get(userId)?.video || []);
  const videoOnUsers = () => [...people.values()].filter((p) => open(p.video)).map((p) => p.userId);
  const presentUsers = () => [...people.values()].filter((p) => p.present).map((p) => p.userId);

  /** A label that stays unique while two present people share a name. */
  function label(userId) {
    const p = people.get(userId);
    if (!p) return `user ${userId}`;
    const sameName = [...people.values()].filter((o) => o.present && o.name && o.name === p.name);
    return sameName.length > 1 ? `${p.name} (id ${userId})` : p.name || `user ${userId}`;
  }

  // --- Zoom App mapping -------------------------------------------------------

  function linkZoomAppParticipant(participantUuid, userId) {
    links.set(`uuid:${participantUuid}`, userId);
    links.set(`id:${userId}`, participantUuid);
  }
  const rtmsUserFor = (participantUuid) => links.get(`uuid:${participantUuid}`) ?? null;
  const zoomAppUuidFor = (userId) => links.get(`id:${userId}`) ?? null;

  // --- end of stream ------------------------------------------------------------

  /** Close every open interval at the last stream timestamp and return the manifest block. */
  function finalize(ts) {
    for (const p of people.values()) {
      closeInterval(p.video, ts, 'stream_end');
      closeInterval(p.speaking, ts, 'stream_end');
      closeInterval(p.presence, ts, 'stream_end');
      p.present = false;
    }
    speaking = null;
    return snapshot();
  }

  function snapshot() {
    return {
      participant_schema_version: PARTICIPANT_SCHEMA_VERSION,
      tenant_id: tenantId,
      meeting_id: meetingId,
      stream_id: streamId,
      participants: [...people.values()].map((p) => ({
        user_id: p.userId,
        name: p.name,
        names: p.names,
        roles: p.roles,
        implicit: p.implicit,
        zoom_app_participant_uuid: zoomAppUuidFor(p.userId),
        presence: p.presence.map((i) => ({ ...i })),
        video: p.video.map((i) => ({ ...i })),
        speaking: p.speaking.map((i) => ({ ...i }))
      }))
    };
  }

  return {
    handleEvent, setRole, attributeAudio, attributeVideo, isVideoOn, videoOnUsers, presentUsers, label,
    linkZoomAppParticipant, rtmsUserFor, zoomAppUuidFor, finalize, snapshot,
    get: (userId) => people.get(userId) || null,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
