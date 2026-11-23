import { EVENT_CODE } from '../shared/codes.js';
import { createMemoryTrace } from '../shared/trace.js';
import { createParticipantRegistry } from './src/participants.js';
import { createVideoSubscriptionManager } from './src/videoSubscription.js';
import { buildMediaParams, fromSdkRaw } from './src/mediaProfile.js';

/**
 * The canned stream is data, not a network client: the same shapes the stream-lifecycle client hands to
 * onEvent and the video-subscription path. It runs offline and touches no credentials.
 */
export function runMediaDemo({ trace = createMemoryTrace(), now = () => 0 } = {}) {
  const registry = createParticipantRegistry({ tenantId: 'offline', meetingId: 'media-demo', streamId: 'canned-stream' });
  const sent = [];
  const manager = createVideoSubscriptionManager({
    registry,
    send: (message) => {
      sent.push(message);
      manager.handleResponse({ msg_type: message.msg_type, status_code: 0, user_id: message.user_id, subscribe: message.subscribe });
    },
    trace,
    streamId: 'canned-stream',
    afterVideoEnds: 'next',
    now
  });

  const events = [
    { event_code: EVENT_CODE.PARTICIPANT_JOIN, timestamp: 1000, participants: [{ user_id: 1, user_name: 'Ana' }, { user_id: 2, user_name: 'Ben' }] },
    { event_code: EVENT_CODE.PARTICIPANT_VIDEO_ON, timestamp: 1010, participants: [{ user_id: 1, user_name: 'Ana' }] },
    { event_code: EVENT_CODE.PARTICIPANT_VIDEO_ON, timestamp: 1011, participants: [{ user_id: 2, user_name: 'Ben' }] },
    { event_code: EVENT_CODE.ACTIVE_SPEAKER_CHANGE, timestamp: 1020, user_id: 1, user_name: 'Ana' },
    { event_code: EVENT_CODE.ACTIVE_SPEAKER_CHANGE, timestamp: 1200, user_id: 2, user_name: 'Ben' },
    { event_code: EVENT_CODE.ACTIVE_SPEAKER_CHANGE, timestamp: 1300, user_id: 0 },
    { event_code: EVENT_CODE.PARTICIPANT_VIDEO_OFF, timestamp: 1400, participants: [{ user_id: 1, user_name: 'Ana' }] }
  ];

  registry.subscribe((change) => {
    manager.handleParticipantChange(change);
    const state = manager.state();
    if (change.type === 'video_on' && state.current === null && state.desired === null) manager.request(change.userId);
  });
  const frames = [];
  const audioSamples = [];
  const addFrame = (userId, timestamp) => frames.push({ userId, timestamp, ...manager.attributeFrame({ userId, timestamp }) });
  const addAudio = (timestamp) => audioSamples.push({ timestamp, ...registry.attributeAudio(timestamp) });

  for (const event of events) {
    registry.handleEvent(event);
    if (event.timestamp === 1020) {
      addFrame(1, 1100);
      addAudio(1100);
    }
    if (event.timestamp === 1200) {
      addFrame(2, 1210);
      addAudio(1210);
    }
    if (event.timestamp === 1300) addAudio(1350);
    if (event.event_code === EVENT_CODE.PARTICIPANT_VIDEO_OFF) {
      addFrame(2, 1410);
      addFrame(1, 1420);
    }
  }

  const audio = buildMediaParams('audio', { codec: 'l16', sampleRate: 16000, channels: 'mono' });
  const video = buildMediaParams('video', { codec: 'h264', resolution: 'hd', fps: 25, mode: 'individual' });
  const translated = fromSdkRaw({
    audio: { sampleRate: 44100, channels: 1 },
    video: { format: 'YUV420', width: 1920, height: 1080, fps: 30 }
  });
  const participants = registry.finalize(1500);

  return {
    events,
    sent,
    frames,
    audioSamples,
    participants,
    mediaParams: { audio: audio.params, video: video.params },
    mediaWarnings: { audio: audio.warnings, video: video.warnings },
    sdkTranslation: { params: { audio: translated.audio.params, video: translated.video.params }, notes: translated.notes },
    subscription: manager.state()
  };
}
