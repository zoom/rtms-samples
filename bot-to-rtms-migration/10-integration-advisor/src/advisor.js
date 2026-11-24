/**
 * Meeting SDK bot -> RTMS decision helper.
 *
 * It encodes the playbook rule "choose RTMS only when all of these are true, choose
 * Meeting SDK if any of those are true, choose a hybrid only for a specific gap".
 * It is advice for planning, not a substitute for testing your own account's policy.
 */

export const DEFAULT_REQUIREMENTS = Object.freeze({
  needsLiveAction: true,
  approvalAcceptable: true,
  externalCustomersCanAuthorize: true,
  canOperateReconnect: true,
  visibleBot: false,
  botSpeaks: false,
  sendsChat: false,
  hostControls: false,
  recordingControl: false,
  adHocJoinByMeetingId: false,
  rawCaptureNotCovered: false,
  allParticipantVideoSimultaneously: false,
  inMeetingUi: false,
  contactCenter: false,
  canonicalRecording: false,
  crmArchiveOnly: false,
  wantsRtmsDataPlane: false
});

export const REQUIREMENT_HELP = {
  needsLiveAction: 'Acts during the meeting (agent assist, prompts, live dashboards). False means minutes of delay is fine.',
  approvalAcceptable: 'An admin policy and host approval flow is acceptable to your product.',
  externalCustomersCanAuthorize: 'Your customers can install the app and authorize the RTMS policy flow.',
  canOperateReconnect: 'You can run reconnect, idempotency and tenant policy.',
  visibleBot: 'The bot must appear as a participant.',
  botSpeaks: 'The bot must speak into the meeting.',
  sendsChat: 'The bot must send chat messages.',
  hostControls: 'The product mutes, admits, removes or changes roles.',
  recordingControl: 'The product starts or stops Zoom recording.',
  adHocJoinByMeetingId: 'The product must join any meeting from only an ID and passcode, with no installed app.',
  rawCaptureNotCovered: 'You need raw capture behavior that RTMS media options do not cover.',
  allParticipantVideoSimultaneously: 'You need every participant camera at the same time.',
  inMeetingUi: 'Users need a panel or controls inside the meeting.',
  contactCenter: 'The audio comes from Zoom Contact Center voice.',
  canonicalRecording: 'You need Zoom canonical recording artifacts as evidence.',
  crmArchiveOnly: 'You only archive finished meetings to a CRM.',
  wantsRtmsDataPlane: 'If a bot is required, you still want RTMS as the independent analytics and compliance feed.'
};

export const SCENARIOS = {
  'ai-assistant': { title: 'AI assistant: summary and action items', requirements: {} },
  'revenue-call-analyzer': { title: 'Revenue call analyzer: stage and next step', requirements: {} },
  'compliance-monitor': { title: 'Compliance monitor: consent, risk, missing item', requirements: { inMeetingUi: true } },
  'live-translation': { title: 'Live translation: captions in a side panel', requirements: { inMeetingUi: true } },
  'quality-management': { title: 'Quality management: call scores', requirements: { needsLiveAction: false, canonicalRecording: true } },
  'visible-assistant': { title: 'Visible assistant: branded participant', requirements: { visibleBot: true, sendsChat: true } },
  'voice-agent': { title: 'Voice agent: spoken interaction', requirements: { visibleBot: true, botSpeaks: true } },
  'incident-scribe': { title: 'Incident scribe: decision timeline', requirements: {} },
  'support-wrap-up': { title: 'Support wrap-up: ticket draft', requirements: {} },
  'media-archive': { title: 'Media archive: customer-owned media', requirements: {} },
  'crm-archive': { title: 'CRM archive: finished meetings only', requirements: { needsLiveAction: false, crmArchiveOnly: true } },
  'contact-center-assist': { title: 'Contact center assist: live agent guidance', requirements: { contactCenter: true } },
  'bot-with-compliance-feed': { title: 'Speaking bot plus independent compliance feed', requirements: { visibleBot: true, botSpeaks: true, wantsRtmsDataPlane: true } },
  'ad-hoc-joiner': { title: 'Join any meeting from an ID and passcode', requirements: { adHocJoinByMeetingId: true, externalCustomersCanAuthorize: false } }
};

const SURFACES = {
  rtms: 'Inbound media and metadata. No participant, no controls.',
  meetingSdk: 'Presence, chat, audio and video injection, host controls, recording control.',
  zoomApps: 'Trusted in-client UI, user and meeting context, startRTMS() and stopRTMS().',
  webhooksRest: 'Lifecycle events, REST start and stop, recordings and reporting.'
};

export function advise(input = {}) {
  const unknown = Object.keys(input).filter((k) => !(k in DEFAULT_REQUIREMENTS));
  if (unknown.length) throw new Error(`Unknown requirement(s): ${unknown.join(', ')}`);
  const r = { ...DEFAULT_REQUIREMENTS, ...input };

  const hard = [];
  if (!r.approvalAcceptable) hard.push('RTMS needs an admin policy and, often, host approval. You cannot bypass the approval modal.');
  if (!r.externalCustomersCanAuthorize) hard.push('External customers cannot authorize the RTMS app and policy flow, so no stream can start for them.');
  if (r.adHocJoinByMeetingId) hard.push('RTMS cannot join from a meeting ID and passcode. It is an authorized data feed, not a meeting client.');
  if (r.rawCaptureNotCovered) hard.push('You need raw capture behavior that RTMS media options do not cover.');
  if (r.allParticipantVideoSimultaneously) hard.push('RTMS does not give unlimited simultaneous individual camera streams. Validate the current limit, or keep Meeting SDK raw video.');

  const gaps = [];
  if (r.visibleBot) gaps.push('a visible participant');
  if (r.botSpeaks) gaps.push('speech into the meeting');
  if (r.sendsChat) gaps.push('sending chat');
  if (r.hostControls) gaps.push('host controls');
  if (r.recordingControl) gaps.push('recording control');

  const pieces = { rtms: [], meetingSdk: [], zoomApps: [], webhooksRest: [] };
  const conditions = [];
  const reasons = [];
  let recommendation;

  if (r.crmArchiveOnly || !r.needsLiveAction) {
    recommendation = 'recording-api';
    reasons.push(r.crmArchiveOnly
      ? 'You only archive finished meetings. Use recording webhooks and the Recording REST API, not a live stream.'
      : 'Nothing has to happen during the meeting, so minutes of delay is fine. Use recording webhooks and REST. Do not use RTMS just as a downloader.');
    pieces.webhooksRest.push('Recording-completed webhook, then Recording REST API download');
    if (gaps.length) {
      pieces.meetingSdk.push(`Needed only for: ${list(gaps)}`);
      conditions.push(`RTMS does not provide ${list(gaps)}. Use Meeting SDK or a host integration for those.`);
    }
  } else if (hard.length) {
    recommendation = 'meeting-sdk';
    reasons.push(...hard);
    pieces.meetingSdk.push('Join, capture raw media and perform the actions you need');
    if (r.wantsRtmsDataPlane) conditions.push('You asked for RTMS as the data plane, but the blockers above apply to it too. Resolve them first.');
  } else if (gaps.length && r.wantsRtmsDataPlane) {
    recommendation = 'hybrid';
    reasons.push(`The bot must provide ${list(gaps)}. RTMS cannot do that, but you also want it as the independent analytics and compliance feed.`);
    pieces.meetingSdk.push(`Presence and actions: ${list(gaps)}`);
    pieces.rtms.push('Analytics and compliance feed');
    pieces.webhooksRest.push('Lifecycle and retrieval');
    conditions.push('Keep one identity, consent and audit service across both mechanisms.');
  } else if (gaps.length) {
    recommendation = 'meeting-sdk';
    reasons.push(`The bot must provide ${list(gaps)}. RTMS is receive-only and cannot do that.`);
    pieces.meetingSdk.push('Participant runtime and actions');
    conditions.push('If you also need analytics that keep running independent of the bot, add RTMS as the data plane (hybrid).');
  } else {
    recommendation = 'rtms';
    reasons.push('You need inbound media and metadata, an approval flow is acceptable, and none of the Meeting SDK only needs apply.');
    pieces.rtms.push(r.contactCenter ? 'Contact Center voice RTMS' : 'Live audio, video, share, transcript and chat');
    pieces.webhooksRest.push('Lifecycle webhooks, optional REST start and stop');
    if (r.inMeetingUi) {
      pieces.zoomApps.push('In-meeting panel and optional startRTMS() / stopRTMS()');
      reasons.push('You need UI inside the meeting, so pair RTMS with a Zoom App.');
    }
    if (r.contactCenter) conditions.push('Contact Center voice RTMS needs an entitlement and event coverage. Validate both first.');
    if (r.canonicalRecording) {
      pieces.webhooksRest.push('Recording webhook and REST for authoritative evidence');
      conditions.push('Use live RTMS for action and recordings for canonical evidence.');
    }
    if (!r.canOperateReconnect) {
      conditions.push('You must be able to run reconnect, idempotency and tenant policy. Start with 50-start-and-approval and 60-stream-lifecycle-client before committing.');
    }
    conditions.push('The meeting client still shows the active-app indicator. Do not promise invisible capture.');
  }

  return {
    recommendation,
    label: LABELS[recommendation],
    reasons,
    conditions,
    pieces: Object.fromEntries(Object.entries(pieces).map(([k, v]) => [k, { owns: SURFACES[k], uses: v }])),
    next: NEXT[recommendation]
  };
}

const LABELS = {
  rtms: 'Use RTMS',
  'meeting-sdk': 'Keep or use Meeting SDK',
  hybrid: 'Hybrid: Meeting SDK for presence, RTMS for the data feed',
  'recording-api': 'Use recording webhooks and REST, not live streaming'
};

const NEXT = {
  rtms: ['50-start-and-approval', '60-stream-lifecycle-client', '61-media-and-participants'],
  'meeting-sdk': ['Stay on Meeting SDK. Re-check each blocker when your product contract changes.'],
  hybrid: ['50-start-and-approval', '60-stream-lifecycle-client', '61-media-and-participants'],
  'recording-api': ['70-reporting-dashboard (for the reporting side)']
};

function list(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
