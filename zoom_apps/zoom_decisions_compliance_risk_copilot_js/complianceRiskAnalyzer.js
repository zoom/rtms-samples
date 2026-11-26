import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';

const DEFAULT_ENDPOINT = 'https://api.zoom.us/v2/aiservices/decisions/decide';
const DEFAULT_MODEL = 'zoom-decisions';
const DEFAULT_HISTORY_TURNS = 12;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_TRANSCRIPT_CHARS = 8;

const SHORT_CONSENT_PATTERN = /^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|fine|agree|agreed|i agree|i consent|consent|correct|that is correct|right|confirmed|confirm|understood|i understand|got it|decline|i decline|disagree|i disagree|wait|stop|cancel|approved|proceed)[.!?,\s]*$/i;

export const CHECKLIST_ITEMS = Object.freeze([
  { key: 'identity', label: 'Identity' },
  { key: 'consent', label: 'Consent' },
  { key: 'fees', label: 'Fees' },
  { key: 'risks', label: 'Risks' },
  { key: 'alternatives', label: 'Alternatives' },
  { key: 'understanding', label: 'Understanding' }
]);

const MISSING_TO_CHECKLIST_KEY = Object.freeze({
  identity: 'identity',
  consent: 'consent',
  fees: 'fees',
  risks: 'risks',
  alternatives: 'alternatives',
  customer_understanding: 'understanding'
});

const sessions = new Map();
const streamIdByMeetingId = new Map();

export const COMPLIANCE_QUESTIONS = Object.freeze({
  conversation_stage: {
    type: 'choice',
    instructions: 'Choose the current stage of the regulated customer conversation.',
    choices: [
      { value: 'greeting', description: 'Opening, introductions, or agenda setting.' },
      { value: 'identity_verification', description: 'Establishing or verifying the customer identity.' },
      { value: 'need_collection', description: 'Understanding the request, issue, or objective.' },
      { value: 'disclosure', description: 'Providing material terms, fees, risks, limitations, or alternatives.' },
      { value: 'customer_questions', description: 'Customer is asking about terms, risks, or consequences.' },
      { value: 'resolution', description: 'Agreeing on a concrete action, remedy, or next step.' },
      { value: 'closing', description: 'Confirming completion, consent, follow-up, or escalation.' },
      { value: 'unclear', description: 'The stage cannot be determined from available context.' }
    ]
  },
  compliance_state: {
    type: 'choice',
    instructions: 'Choose the overall compliance state supported by the conversation.',
    choices: [
      { value: 'compliant', description: 'Required disclosures and checks are present or not yet applicable.' },
      { value: 'minor_gap', description: 'A low impact item is missing, ambiguous, or incomplete.' },
      { value: 'material_gap', description: 'A required disclosure, consent, verification, or remedy is missing.' },
      { value: 'customer_confusion', description: 'The customer misunderstands terms, risks, costs, or consequences.' },
      { value: 'unclear', description: 'Compliance state cannot be determined from available context.' }
    ]
  },
  missing_requirement: {
    type: 'choice',
    instructions: 'Choose the single most important compliance item still missing or unclear.',
    choices: [
      { value: 'none', description: 'No material compliance item is missing now.' },
      { value: 'identity', description: 'Identity, account ownership, or authority is not established.' },
      { value: 'consent', description: 'Recording, data use, terms, or transactional consent is not established.' },
      { value: 'fees', description: 'Fees, charges, penalties, or payment obligations are unclear.' },
      { value: 'risks', description: 'Material risks, limitations, exclusions, or consequences are unclear.' },
      { value: 'alternatives', description: 'Required alternatives, options, or rights are not explained.' },
      { value: 'documentation', description: 'The agreement, disclosure, evidence, or record is incomplete.' },
      { value: 'next_steps', description: 'Owner, timing, remedy, or follow-up is not confirmed.' },
      { value: 'escalation', description: 'An issue needs supervisory or specialist review.' },
      { value: 'customer_understanding', description: 'The customer has not confirmed understanding of the material terms.' }
    ]
  },
  next_action: {
    type: 'choice',
    instructions: 'Choose the single best compliance-safe next move for the agent.',
    choices: [
      { value: 'verify_identity', description: 'Verify identity, account ownership, or authority before proceeding.' },
      { value: 'capture_consent', description: 'Obtain and record the required consent or agreement.' },
      { value: 'state_material_terms', description: 'State the missing fee, risk, limitation, or consequence in plain language.' },
      { value: 'offer_alternatives', description: 'Present the required alternative, option, or customer right.' },
      { value: 'confirm_understanding', description: 'Ask the customer to restate the material term or consequence.' },
      { value: 'document_exception', description: 'Record the exception, evidence, or approval supporting the decision.' },
      { value: 'confirm_next_steps', description: 'Confirm the owner, action, deadline, and follow-up.' },
      { value: 'escalate', description: 'Escalate to a supervisor or specialist for review.' },
      { value: 'pause_and_listen', description: 'Let the customer finish before adding another required statement.' }
    ]
  },
  consent_recorded: {
    type: 'predicate',
    instructions: 'The conversation contains clear evidence that the relevant consent was obtained and recorded.'
  },
  compliance_risk: {
    type: 'score',
    instructions: 'Score the current regulatory, financial, or customer-harm risk.',
    levels: [
      { label: 'Low', description: 'No material gap and the customer understands the terms.' },
      { label: 'Minor', description: 'Low-impact ambiguity with a simple correction available.' },
      { label: 'Moderate', description: 'A material item is missing, ambiguous, or unconfirmed.' },
      { label: 'High', description: 'A required disclosure, consent, verification, or remedy is absent.' },
      { label: 'Critical', description: 'Immediate harm, breach, or regulatory exposure is likely without action.' }
    ]
  }
});

const ACTION_GUIDANCE = Object.freeze({
  verify_identity: ['Verify identity', 'Please confirm the account holder name and one additional identifier before we continue.'],
  capture_consent: ['Capture consent', 'May I record your agreement to these terms for our compliance record?'],
  state_material_terms: ['State material terms', 'To be clear, the applicable fee, limitation, or consequence is as follows.'],
  offer_alternatives: ['Offer alternatives', 'You also have these options, and I can explain the tradeoffs before you choose.'],
  confirm_understanding: ['Confirm understanding', 'Could you tell me how you understand the fee or consequence so I can correct anything now?'],
  document_exception: ['Document the exception', 'I will record the exception, the evidence, and the approving person now.'],
  confirm_next_steps: ['Confirm next steps', 'To confirm, the owner is responsible for the action by the agreed date.'],
  escalate: ['Escalate for review', 'I am bringing in the appropriate reviewer to confirm this before we proceed.'],
  pause_and_listen: ['Pause and listen', 'Please finish your question. I will address the material terms immediately afterward.']
});

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function getConfig() {
  const apiKey = String(process.env.ZOOM_AI_SERVICES_API_KEY || '').trim();
  if (!apiKey) throw new Error('ZOOM_AI_SERVICES_API_KEY is required');
  const rawTimeout = process.env.ZOOM_DECISIONS_TIMEOUT_MS || process.env.COMPLIANCE_TIMEOUT_MS;
  return {
    apiKey,
    endpoint: process.env.ZOOM_DECISIONS_URL || DEFAULT_ENDPOINT,
    model: process.env.ZOOM_DECISIONS_MODEL || DEFAULT_MODEL,
    historyTurns: positiveInteger(process.env.COMPLIANCE_HISTORY_TURNS, DEFAULT_HISTORY_TURNS, 'COMPLIANCE_HISTORY_TURNS'),
    timeoutMs: positiveInteger(rawTimeout, DEFAULT_TIMEOUT_MS, 'ZOOM_DECISIONS_TIMEOUT_MS')
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSpeakerKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'agent' || value === 'customer') return value;
  return null;
}

export function formatRoleLabel(role) {
  const normalized = normalizeRole(role);
  if (normalized === 'agent') return '[Agent]';
  if (normalized === 'customer') return '[Customer]';
  return '[Speaker]';
}

export function isShortConsentUtterance(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return SHORT_CONSENT_PATTERN.test(trimmed);
}

export function shouldAnalyzeTranscript(text, minimumCharacters = DEFAULT_MIN_TRANSCRIPT_CHARS) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (trimmed.length >= Math.max(1, Number(minimumCharacters) || DEFAULT_MIN_TRANSCRIPT_CHARS)) {
    return true;
  }
  return isShortConsentUtterance(trimmed);
}

function createInitialChecklist() {
  return Object.fromEntries(
    CHECKLIST_ITEMS.map(({ key, label }) => [
      key,
      { key, label, status: 'pending', updatedAt: null, evidenceTurnId: null }
    ])
  );
}

export function cloneChecklist(checklist) {
  return Object.fromEntries(
    Object.entries(checklist).map(([key, item]) => [key, { ...item }])
  );
}

export function updateChecklistFromAnalysis(checklist, analysis, turnId = null, now = Date.now()) {
  if (!checklist || !analysis) return checklist;

  const missingKey = MISSING_TO_CHECKLIST_KEY[analysis.missingRequirement?.value] || null;
  const complianceState = analysis.complianceState?.value || 'unclear';
  const stage = analysis.conversationStage?.value || 'unclear';
  const consentProb = finiteNumber(analysis.consentRecorded, 0);

  const setItem = (key, status) => {
    if (!checklist[key]) return;
    checklist[key] = {
      ...checklist[key],
      status,
      updatedAt: now,
      evidenceTurnId: turnId || checklist[key].evidenceTurnId
    };
  };

  if (missingKey) {
    setItem(missingKey, 'missing');
  }

  if (complianceState === 'customer_confusion') {
    setItem('understanding', 'missing');
  }

  if (consentProb >= 0.7 && missingKey !== 'consent') {
    setItem('consent', 'completed');
  }

  if (complianceState === 'compliant') {
    // Any item previously marked missing that is no longer flagged missing is now satisfied.
    for (const { key } of CHECKLIST_ITEMS) {
      if (checklist[key]?.status === 'missing' && key !== missingKey) {
        setItem(key, 'completed');
      }
    }

    if (
      ['identity_verification', 'need_collection', 'disclosure', 'customer_questions', 'resolution', 'closing'].includes(stage)
      && missingKey !== 'identity'
      && checklist.identity.status !== 'completed'
    ) {
      if (stage !== 'greeting') setItem('identity', 'completed');
    }

    if (['disclosure', 'customer_questions', 'resolution', 'closing'].includes(stage) && analysis.missingRequirement?.value === 'none') {
      for (const key of ['fees', 'risks', 'alternatives']) {
        if (checklist[key].status !== 'missing') setItem(key, 'completed');
      }
    }

    if (['resolution', 'closing'].includes(stage) && analysis.missingRequirement?.value === 'none') {
      if (checklist.understanding.status !== 'missing') setItem('understanding', 'completed');
    }
  }

  return checklist;
}

function probabilityMap(entries) {
  if (!Array.isArray(entries)) return {};
  return Object.fromEntries(entries.map((entry) => [String(entry.value), finiteNumber(entry.probability)]));
}

function normalizeChoice(answer = {}) {
  return {
    value: String(answer.choice ?? 'unclear'),
    confidence: finiteNumber(answer.confidence),
    probabilities: probabilityMap(answer.probabilities)
  };
}

function normalizeScore(answer = {}) {
  return {
    value: finiteNumber(answer.score),
    confidence: finiteNumber(answer.confidence),
    probabilities: probabilityMap(answer.probabilities)
  };
}

function buildActionOptions(answer, selectedValue) {
  const ranked = Object.entries(probabilityMap(answer?.probabilities))
    .filter(([value, probability]) => ACTION_GUIDANCE[value] && Number.isFinite(Number(probability)))
    .sort((left, right) => Number(right[1]) - Number(left[1]));

  if (!ranked.some(([value]) => value === selectedValue) && ACTION_GUIDANCE[selectedValue]) {
    ranked.unshift([selectedValue, answer?.confidence || 0]);
  }

  return ranked.slice(0, 3).map(([value, probability]) => ({
    value,
    probability: finiteNumber(probability),
    label: ACTION_GUIDANCE[value][0],
    suggestion: ACTION_GUIDANCE[value][1],
    recommended: value === selectedValue
  }));
}

export function normalizeComplianceResponse(payload) {
  const answers = Array.isArray(payload?.answers) ? payload.answers : null;
  if (!answers) throw new Error('Zoom Decisions response did not include an answers array');

  const byName = Object.fromEntries(answers.map((answer) => [answer.name, answer]));
  if (answers.some((answer) => answer.type === 'refusal')) {
    throw new Error('Zoom Decisions returned a refusal');
  }

  const nextAction = normalizeChoice(byName.next_action);
  const guidance = ACTION_GUIDANCE[nextAction.value] || ACTION_GUIDANCE.confirm_understanding;
  const actionOptions = buildActionOptions(byName.next_action, nextAction.value);
  return {
    model: payload.model || null,
    requestId: payload.request_id || null,
    conversationStage: normalizeChoice(byName.conversation_stage),
    complianceState: normalizeChoice(byName.compliance_state),
    missingRequirement: normalizeChoice(byName.missing_requirement),
    nextAction: { ...nextAction, label: guidance[0], suggestion: guidance[1] },
    actionOptions: actionOptions.length > 0
      ? actionOptions
      : [{
          value: nextAction.value,
          probability: nextAction.confidence,
          label: guidance[0],
          suggestion: guidance[1],
          recommended: true
        }],
    consentRecorded: finiteNumber(byName.consent_recorded?.probability),
    complianceRisk: normalizeScore(byName.compliance_risk),
    usage: payload.usage || null
  };
}

async function postDecision(config, body, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Zoom Decisions API returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('Zoom Decisions API returned invalid JSON');
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Zoom Decisions request timed out after ${config.timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sessionFor(streamId, meetingId = null) {
  const key = String(streamId || 'unknown-stream');
  if (!sessions.has(key)) {
    sessions.set(key, {
      streamId: key,
      meetingId: meetingId ? String(meetingId) : null,
      revisionStore: new TranscriptRevisionStore(),
      turnIdsByKey: new Map(),
      speakerRoles: new Map(),
      analysesByTurnId: new Map(),
      latestAnalysis: null,
      checklist: createInitialChecklist(),
      inFlight: false,
      pendingBatch: null
    });
  }
  const session = sessions.get(key);
  if (meetingId) {
    session.meetingId = String(meetingId);
    streamIdByMeetingId.set(String(meetingId), key);
  }
  return session;
}

function resolveSpeakerRole(session, { userId, userName, speakerRole } = {}) {
  const explicit = normalizeRole(speakerRole);
  if (explicit) return explicit;

  const idKey = userId != null && String(userId).trim() !== '' ? `id:${normalizeSpeakerKey(userId)}` : null;
  if (idKey && session.speakerRoles.has(idKey)) return session.speakerRoles.get(idKey);

  const nameKey = userName ? `name:${normalizeSpeakerKey(userName)}` : null;
  if (nameKey && session.speakerRoles.has(nameKey)) return session.speakerRoles.get(nameKey);

  return null;
}

export function setSpeakerRole({ streamId, meetingId, userId, userName, role }) {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return null;

  const resolvedStreamId = streamId || (meetingId ? streamIdByMeetingId.get(String(meetingId)) : null);
  if (!resolvedStreamId) return null;

  const session = sessionFor(resolvedStreamId, meetingId);
  if (userId != null && String(userId).trim() !== '') {
    session.speakerRoles.set(`id:${normalizeSpeakerKey(userId)}`, normalizedRole);
  }
  if (userName && String(userName).trim() !== '') {
    session.speakerRoles.set(`name:${normalizeSpeakerKey(userName)}`, normalizedRole);
  }
  return Object.fromEntries(session.speakerRoles.entries());
}

export function buildDecisionInput(session, latestTurn, historyTurns = DEFAULT_HISTORY_TURNS) {
  const allSentences = session.revisionStore.sentences(session.streamId);
  const recent = allSentences.slice(-Math.max(1, historyTurns));

  const formatTurnLine = (turn) => {
    const speakerName = turn.userName || turn.speaker || `User ${turn.userId ?? 'unknown'}`;
    const role = resolveSpeakerRole(session, {
      userId: turn.userId,
      userName: speakerName,
      speakerRole: turn.speakerRole
    });
    return `${formatRoleLabel(role)} ${speakerName}: ${turn.text}`;
  };

  const latestSpeakerName = latestTurn.userName || latestTurn.speaker || `User ${latestTurn.userId ?? 'unknown'}`;
  const latestRole = resolveSpeakerRole(session, {
    userId: latestTurn.userId,
    userName: latestSpeakerName,
    speakerRole: latestTurn.speakerRole
  });

  return [
    `Regulated conversation context: ${process.env.COMPLIANCE_CONTEXT || 'regulated customer service call'}`,
    '',
    'Recent transcript, oldest first:',
    ...recent.map(formatTurnLine),
    '',
    `Latest speaker: ${formatRoleLabel(latestRole)} ${latestSpeakerName}`,
    `Latest utterance: ${latestTurn.text}`
  ].join('\n');
}

export function recordComplianceTurn({
  turnId,
  streamId,
  meetingId,
  userId,
  userName,
  speakerRole,
  text,
  sentenceId,
  isUpdate,
  attribute,
  startTime,
  endTime,
  timestamp,
  minimumTranscriptCharacters = DEFAULT_MIN_TRANSCRIPT_CHARS
}) {
  const cleanText = String(text || '').trim().slice(0, 4000);
  if (!cleanText) return null;

  const session = sessionFor(streamId, meetingId);
  const displayName = userName || `User ${userId ?? 'unknown'}`;

  const explicitRole = normalizeRole(speakerRole);
  if (explicitRole) {
    if (userId != null && String(userId).trim() !== '') {
      session.speakerRoles.set(`id:${normalizeSpeakerKey(userId)}`, explicitRole);
    }
    if (displayName) {
      session.speakerRoles.set(`name:${normalizeSpeakerKey(displayName)}`, explicitRole);
    }
  }

  const { action, key, sentence } = session.revisionStore.apply({
    streamId: session.streamId,
    rtmsId: meetingId || session.meetingId,
    meetingId: meetingId || session.meetingId,
    userId,
    userName: displayName,
    sentenceId,
    isUpdate,
    attribute,
    startTime,
    endTime,
    text: cleanText,
    timestamp: finiteNumber(timestamp, Date.now())
  });

  let stableTurnId = session.turnIdsByKey.get(key);
  if (!stableTurnId) {
    stableTurnId = turnId || key;
    session.turnIdsByKey.set(key, stableTurnId);
  }

  const resolvedRole = resolveSpeakerRole(session, { userId, userName: displayName, speakerRole });
  const turn = {
    id: stableTurnId,
    key,
    sentenceId: sentence.sentenceId,
    revision: sentence.revision,
    isUpdate: action === 'updated' || action === 'replaced',
    userId: sentence.userId,
    userName: sentence.userName || displayName,
    speaker: sentence.userName || displayName,
    speakerRole: resolvedRole,
    text: sentence.text,
    timestamp: finiteNumber(sentence.timestamp, Date.now())
  };

  return {
    action,
    key,
    turn,
    shouldAnalyze: shouldAnalyzeTranscript(cleanText, minimumTranscriptCharacters),
    checklist: cloneChecklist(session.checklist)
  };
}

async function executeDecisionCall(session, latestTurn, meetingId, fetchImpl) {
  const config = getConfig();
  const startedAt = Date.now();
  const input = buildDecisionInput(session, latestTurn, config.historyTurns);
  const raw = await postDecision(
    config,
    {
      input,
      model: config.model,
      reference_id: latestTurn.id,
      questions: Object.entries(COMPLIANCE_QUESTIONS).map(([name, question]) => ({ name, ...question }))
    },
    fetchImpl
  );

  const normalized = normalizeComplianceResponse(raw);
  updateChecklistFromAnalysis(session.checklist, normalized, latestTurn.id);

  const analysis = {
    ...normalized,
    meetingId: meetingId || session.meetingId || null,
    latencyMs: Date.now() - startedAt,
    analyzedAt: Date.now(),
    turn: latestTurn,
    checklist: cloneChecklist(session.checklist)
  };

  session.analysesByTurnId.set(latestTurn.id, analysis);
  session.latestAnalysis = analysis;
  return analysis;
}

/**
 * Evaluates compliance for a turn, coalescing rapid bursts so at most one
 * follow-up Decisions API call runs against the latest conversation state.
 */
export async function analyzeComplianceTurn({
  turnId,
  streamId,
  meetingId,
  userId,
  userName,
  speakerRole,
  text,
  sentenceId,
  isUpdate,
  attribute,
  timestamp,
  alreadyRecorded = false,
  fetchImpl = fetch
}) {
  const session = sessionFor(streamId, meetingId);
  let turn;

  if (alreadyRecorded) {
    const cleanText = String(text || '').trim().slice(0, 4000);
    if (!cleanText) throw new Error('Transcript text is empty');
    const displayName = userName || `User ${userId ?? 'unknown'}`;
    turn = {
      id: turnId,
      userId,
      userName: displayName,
      speaker: displayName,
      speakerRole: resolveSpeakerRole(session, { userId, userName: displayName, speakerRole }),
      text: cleanText,
      timestamp: finiteNumber(timestamp, Date.now())
    };
  } else {
    const recorded = recordComplianceTurn({
      turnId,
      streamId,
      meetingId,
      userId,
      userName,
      speakerRole,
      text,
      sentenceId,
      isUpdate,
      attribute,
      timestamp
    });
    if (!recorded) throw new Error('Transcript text is empty');
    turn = recorded.turn;
  }

  return new Promise((resolve, reject) => {
    const runNext = async (batch) => {
      session.inFlight = true;
      try {
        const analysis = await executeDecisionCall(session, batch.latestTurn, batch.meetingId, batch.fetchImpl);
        for (const waiter of batch.waiters) {
          waiter.resolve({ ...analysis, coalesced: batch.waiters.length > 1 });
        }
      } catch (error) {
        for (const waiter of batch.waiters) {
          waiter.reject(error);
        }
      } finally {
        session.inFlight = false;
        if (session.pendingBatch) {
          const nextBatch = session.pendingBatch;
          session.pendingBatch = null;
          void runNext(nextBatch);
        }
      }
    };

    if (!session.inFlight) {
      void runNext({
        latestTurn: turn,
        meetingId,
        fetchImpl,
        waiters: [{ resolve, reject }]
      });
    } else {
      if (!session.pendingBatch) {
        session.pendingBatch = {
          latestTurn: turn,
          meetingId,
          fetchImpl,
          waiters: [{ resolve, reject }]
        };
      } else {
        session.pendingBatch.latestTurn = turn;
        session.pendingBatch.meetingId = meetingId || session.pendingBatch.meetingId;
        session.pendingBatch.fetchImpl = fetchImpl;
        session.pendingBatch.waiters.push({ resolve, reject });
      }
    }
  });
}

export function getComplianceSessionSnapshot({ streamId = null, meetingId = null } = {}) {
  const resolvedStreamId = streamId || (meetingId ? streamIdByMeetingId.get(String(meetingId)) : null);
  const session = resolvedStreamId ? sessions.get(String(resolvedStreamId)) : null;
  if (!session) {
    return {
      streamId: null,
      meetingId: meetingId ? String(meetingId) : null,
      turns: [],
      checklist: createInitialChecklist(),
      latestAnalysis: null,
      speakerRoles: {}
    };
  }

  const turns = session.revisionStore.sentences(session.streamId).map((sentence) => {
    const key = `${sentence.streamId}:${sentence.channelId ?? sentence.userId ?? null}:${sentence.sentenceId ?? `#${sentence.order}`}`;
    const id = session.turnIdsByKey.get(key) || key;
    const displayName = sentence.userName || `User ${sentence.userId ?? 'unknown'}`;
    return {
      id,
      key,
      sentenceId: sentence.sentenceId,
      revision: sentence.revision,
      isUpdate: sentence.revision > 0,
      userId: sentence.userId,
      userName: displayName,
      speakerRole: resolveSpeakerRole(session, { userId: sentence.userId, userName: displayName }),
      text: sentence.text,
      timestamp: finiteNumber(sentence.timestamp, Date.now()),
      analysis: session.analysesByTurnId.get(id) || null
    };
  });

  return {
    streamId: session.streamId,
    meetingId: session.meetingId,
    turns,
    checklist: cloneChecklist(session.checklist),
    latestAnalysis: session.latestAnalysis,
    speakerRoles: Object.fromEntries(session.speakerRoles.entries())
  };
}

export function resetComplianceSession(streamId) {
  if (!streamId) return;
  const key = String(streamId);
  const existing = sessions.get(key);
  if (existing?.meetingId && streamIdByMeetingId.get(existing.meetingId) === key) {
    streamIdByMeetingId.delete(existing.meetingId);
  }
  existing?.revisionStore?.clear();
  sessions.delete(key);
}

export function resetAllComplianceSessions() {
  for (const session of sessions.values()) {
    session.revisionStore?.clear();
  }
  sessions.clear();
  streamIdByMeetingId.clear();
}
