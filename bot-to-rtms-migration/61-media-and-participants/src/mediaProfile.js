/**
 * Replacing Meeting SDK raw PCM and YUV with RTMS media.
 *
 * Meeting SDK hands you raw frames. RTMS negotiates a format per concrete media type in the
 * data handshake, and sends audio, H.264 or image frames in that format. Code values come from
 * library/javascript/rtmsManager/utils/rtmsMediaParams.js.
 */

export const CODES = Object.freeze({
  contentType: { rawAudio: 2, rawVideo: 3, fileStream: 4, text: 5 },
  audioCodec: { l16: 1, g711: 2, g722: 3, opus: 4 },
  videoCodec: { jpg: 5, h264: 7 },
  sampleRate: { 8000: 0, 16000: 1, 32000: 2, 48000: 3 },
  channels: { mono: 1, stereo: 2 },
  audioDataOpt: { mixed: 1, multiStreams: 2 },
  videoDataOpt: { singleActive: 3, singleIndividual: 4 },
  resolution: { sd: 1, hd: 2, fhd: 3, qhd: 4 }
});

/**
 * Build the media_params for one concrete media type. Returns { params, warnings, errors }.
 * An error means do not send this handshake.
 */
export function buildMediaParams(mediaType, options = {}) {
  const warnings = [];
  const errors = [];
  switch (mediaType) {
    case 'audio': {
      const { codec = 'l16', sampleRate = 16000, channels = 'mono', perParticipant = false, sendRateMs = 100 } = options;
      if (!(codec in CODES.audioCodec)) errors.push(`unknown audio codec "${codec}"`);
      if (!(sampleRate in CODES.sampleRate)) errors.push(`sample rate ${sampleRate} is not one of ${Object.keys(CODES.sampleRate).join(', ')}`);
      if (!(channels in CODES.channels)) errors.push(`channels must be mono or stereo`);
      if (channels === 'stereo' && codec !== 'opus') errors.push('stereo audio requires the Opus codec');
      if (perParticipant) warnings.push('Per-participant audio (multi-streams) is available only where enabled. Validate speaker metadata and channel mapping before you migrate.');
      if (errors.length) return { params: null, warnings, errors };
      return {
        params: { content_type: CODES.contentType.rawAudio, sample_rate: CODES.sampleRate[sampleRate], channel: CODES.channels[channels], codec: CODES.audioCodec[codec], data_opt: perParticipant ? CODES.audioDataOpt.multiStreams : CODES.audioDataOpt.mixed, send_rate: sendRateMs },
        warnings, errors
      };
    }
    case 'video': {
      const { codec = 'h264', resolution = 'hd', fps = 25, mode = 'activeSpeaker' } = options;
      if (codec === 'png') errors.push('PNG was removed in RTMS protocol V2; use jpg or h264');
      else if (!(codec in CODES.videoCodec)) errors.push(`unknown video codec "${codec}"`);
      if (!(resolution in CODES.resolution)) errors.push(`resolution must be one of ${Object.keys(CODES.resolution).join(', ')}`);
      if (!['activeSpeaker', 'individual'].includes(mode)) errors.push('video mode must be activeSpeaker or individual');
      if (!Number.isInteger(fps) || fps < 1 || fps > 30) errors.push('fps must be a whole number from 1 to 30');
      if (mode === 'individual') warnings.push('Individual video carries ONE selected participant at a time. For every camera at once, validate the current limit or keep Meeting SDK raw video.');
      if (codec === 'h264') warnings.push('H.264 is encoded video, not raw YUV. Decode it in your pipeline.');
      if (errors.length) return { params: null, warnings, errors };
      return {
        params: { content_type: CODES.contentType.rawVideo, codec: CODES.videoCodec[codec], data_opt: mode === 'individual' ? CODES.videoDataOpt.singleIndividual : CODES.videoDataOpt.singleActive, resolution: CODES.resolution[resolution], fps },
        warnings, errors
      };
    }
    case 'share': {
      const { codec = 'jpg', resolution = 'hd', fps = 1 } = options;
      if (codec === 'png') errors.push('PNG was removed in RTMS protocol V2; use jpg or h264');
      else if (!(codec in CODES.videoCodec)) errors.push(`unknown share codec "${codec}"`);
      if (!(resolution in CODES.resolution)) errors.push(`resolution must be one of ${Object.keys(CODES.resolution).join(', ')}`);
      if (!Number.isInteger(fps) || fps < 1 || fps > 30) errors.push('fps must be a whole number from 1 to 30');
      if (errors.length) return { params: null, warnings, errors };
      warnings.push('Screen share is its own stream, separate from camera video.');
      return { params: { content_type: CODES.contentType.rawVideo, codec: CODES.videoCodec[codec], resolution: CODES.resolution[resolution], fps }, warnings, errors };
    }
    case 'transcript': {
      const { languageId = 9, detectLanguage = true } = options; // 9 is English
      if (!Number.isInteger(languageId) || languageId < 0) errors.push('languageId must be a whole number from the RTMS language list');
      if (errors.length) return { params: null, warnings, errors };
      return { params: { content_type: CODES.contentType.text, src_language: languageId, enable_lid: Boolean(detectLanguage) }, warnings, errors };
    }
    case 'chat':
      warnings.push('Chat is receive-only. You cannot send chat through RTMS.');
      return { params: { content_type: CODES.contentType.text }, warnings, errors };
    default:
      return { params: null, warnings, errors: [`unknown media type "${mediaType}"`] };
  }
}

/**
 * Suggest RTMS parameters from what your Meeting SDK bot consumed today.
 *   sdk = { audio: { sampleRate, channels }, video: { format: 'YUV420', width, height, fps } }
 */
export function fromSdkRaw(sdk = {}) {
  const out = { audio: null, video: null, notes: [] };
  if (sdk.audio) {
    const rates = Object.keys(CODES.sampleRate).map(Number);
    const nearest = rates.reduce((best, r) => (Math.abs(r - sdk.audio.sampleRate) < Math.abs(best - sdk.audio.sampleRate) ? r : best), rates[0]);
    const stereo = sdk.audio.channels === 2;
    if (nearest !== sdk.audio.sampleRate) out.notes.push(`RTMS offers ${rates.join(', ')} Hz. ${sdk.audio.sampleRate} Hz maps to ${nearest} Hz: resample if your pipeline needs the original rate.`);
    out.audio = buildMediaParams('audio', { codec: stereo ? 'opus' : 'l16', sampleRate: nearest, channels: stereo ? 'stereo' : 'mono' });
    if (stereo) out.notes.push('Stereo is only available with Opus. Decode it before your PCM pipeline.');
  }
  if (sdk.video) {
    const height = Number(sdk.video.height) || 720;
    const resolution = height >= 1440 ? 'qhd' : height >= 1080 ? 'fhd' : height >= 720 ? 'hd' : 'sd';
    out.video = buildMediaParams('video', { codec: 'h264', resolution, fps: Math.min(30, Number(sdk.video.fps) || 25) });
    out.notes.push(`${sdk.video.format || 'Raw'} frames become H.264 (${resolution}). Decode to YUV in your pipeline, or request JPG frames for screen share.`);
  }
  out.notes.push('Persist sequence, timestamp and user metadata. Do not assume frame ordering survives a reconnect.');
  return out;
}
