/**
 * Reference tables from MEETING_BOT_PLAYBOOKS.md, kept as data so the CLI, the docs
 * and the tests all read the same thing.
 */

/** "Which bot controls, media injection, and recording actions require another API?" */
export const CAPABILITY_MATRIX = [
  { capability: 'Receive audio, video, share, transcript, chat', rtms: true, approach: 'RTMS concrete media sockets and scopes' },
  { capability: 'Send chat', rtms: false, approach: 'Meeting SDK, chat integration, or Zoom App UI' },
  { capability: 'Play audio into the meeting', rtms: false, approach: 'Meeting SDK audio injection' },
  { capability: 'Send video', rtms: false, approach: 'Meeting SDK' },
  { capability: 'React, raise hand, change layout', rtms: false, approach: 'Meeting SDK or client integration' },
  { capability: 'Mute, rename, admit, remove, cohost', rtms: false, approach: 'Meeting SDK role and permission, or host integration' },
  { capability: 'Start or stop Zoom recording', rtms: false, approach: 'Meeting SDK recording controller, or host / REST policy' },
  { capability: 'Download cloud recording', rtms: false, approach: 'Recording webhook plus Recording REST API' },
  { capability: 'Force approval or bypass denial', rtms: false, approach: 'Fix policy, presence, approval or entitlement' }
];

/** "Can Zoom RTMS capture the same media as a Meeting SDK bot?" */
export const MEDIA_PARITY = [
  { media: 'Mixed audio', rtms: 'Yes', note: 'Choose codec, sample rate, channel and send interval.' },
  { media: 'Per-participant audio', rtms: 'Where available (AUDIO_MULTI_STREAMS)', note: 'Validate speaker metadata and channel mapping before migrating.' },
  { media: 'Active-speaker video', rtms: 'Yes', note: 'A single active stream.' },
  { media: 'Individual camera video', rtms: 'One selected participant at a time', note: 'Subscribe and unsubscribe by user. Not unlimited simultaneous cameras.' },
  { media: 'Screen share', rtms: 'Yes', note: 'A separate stream from camera video.' },
  { media: 'Transcript', rtms: 'Yes', note: 'Zoom transcript, or send audio to your own ASR.' },
  { media: 'Chat', rtms: 'Receive only', note: 'You cannot send chat through RTMS.' }
];

/** Meeting SDK habit -> what RTMS needs instead. */
export const ASSUMPTION_CHANGES = [
  { sdk: 'The bot joins from a meeting ID and passcode', rtms: 'There is no join. An installed app, an eligible app user, admin policy and any host approval authorize a feed.' },
  { sdk: 'Presence is a participant in the roster', rtms: 'Presence is an authorized feed. The app shows only in the client active-app indicator.' },
  { sdk: 'Your service decides when to join', rtms: 'A product-specific *_rtms_started webhook says the stream exists. Do not connect before it.' },
  { sdk: 'One SDK connection carries everything', rtms: 'One signaling WebSocket plus one media WebSocket per concrete media type.' },
  { sdk: 'The SDK manages the connection', rtms: 'You own keep-alives, reconnect, backoff and jitter.' },
  { sdk: 'Bot presence survives a network blip', rtms: 'A stream can stop. A new stream needs a new webhook and a new rtms_stream_id.' },
  { sdk: 'SDK callbacks report state', rtms: 'Webhooks plus RTMS state messages. Reconcile them by ID and timestamp.' },
  { sdk: 'Local recording continues through an outage', rtms: 'You persist and reconcile partial media yourself. buffer_data covers a short startup gap only.' },
  { sdk: 'A service account can attend any meeting', rtms: 'Every stream ties to a tenant, an app user, a policy snapshot and a consent reference.' },
  { sdk: 'Raw PCM and YUV frames', rtms: 'Negotiated audio codecs and H.264 or image frames. Persist sequence, timestamp and user metadata.' },
  { sdk: 'Participants are tracked by display name', rtms: 'Use a stream-scoped participant registry keyed by the RTMS user ID.' },
  { sdk: 'Control actions come with the SDK', rtms: 'RTMS is receive-only. Chat, speech, host controls and recording control need other APIs.' }
];

/** "Which capability belongs where?" */
export const WHERE_IT_BELONGS = [
  { capability: 'Receive media', rtms: 'Yes', meetingSdk: 'Yes', zoomApps: 'Indirect', webhooksRest: 'Async' },
  { capability: 'Send media', rtms: 'No', meetingSdk: 'Yes', zoomApps: 'Product-dependent', webhooksRest: 'No' },
  { capability: 'Send chat', rtms: 'No', meetingSdk: 'Yes', zoomApps: 'Product-dependent', webhooksRest: 'Limited' },
  { capability: 'Participant tile', rtms: 'No', meetingSdk: 'Yes', zoomApps: 'No', webhooksRest: 'No' },
  { capability: 'Active-app indicator', rtms: 'Yes', meetingSdk: 'Yes', zoomApps: 'Product-dependent', webhooksRest: 'No' },
  { capability: 'Host controls', rtms: 'No', meetingSdk: 'Role-based', zoomApps: 'Limited', webhooksRest: 'Some APIs' },
  { capability: 'Recordings', rtms: 'No', meetingSdk: 'No', zoomApps: 'No', webhooksRest: 'Yes' }
];
