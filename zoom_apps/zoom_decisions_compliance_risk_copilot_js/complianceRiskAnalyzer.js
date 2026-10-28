const DEFAULT_ENDPOINT = 'https://api.zoom.us/v2/aiservices/decisions/decide';
const DEFAULT_MODEL = 'zoom-decisions';
const DEFAULT_HISTORY_TURNS = 12;
const DEFAULT_TIMEOUT_MS = 10000;

const sessions = new Map();

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
  return {
    apiKey,
    endpoint: process.env.ZOOM_DECISIONS_URL || DEFAULT_ENDPOINT,
    model: process.env.ZOOM_DECISIONS_MODEL || DEFAULT_MODEL,
    historyTurns: positiveInteger(process.env.COMPLIANCE_HISTORY_TURNS, DEFAULT_HISTORY_TURNS, 'COMPLIANCE_HISTORY_TURNS'),
    timeoutMs: positiveInteger(process.env.COMPLIANCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'COMPLIANCE_TIMEOUT_MS')
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

async function postDecision(config, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
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

function buildDecisionInput(session, latestTurn) {
  return [
    `Regulated conversation context: ${process.env.COMPLIANCE_CONTEXT || 'regulated customer service call'}`,
    '',
    'Recent transcript, oldest first:',
    ...session.history.map((turn) => `${turn.speaker}: ${turn.text}`),
    '',
    `Latest speaker: ${latestTurn.speaker}`,
    `Latest utterance: ${latestTurn.text}`
  ].join('\n');
}

function sessionFor(streamId) {
  const key = String(streamId || 'unknown-stream');
  if (!sessions.has(key)) sessions.set(key, { history: [], queue: Promise.resolve() });
  return sessions.get(key);
}

export async function analyzeComplianceTurn({ turnId, streamId, meetingId, userId, userName, text, timestamp }) {
  const session = sessionFor(streamId);
  const work = async () => {
    const config = getConfig();
    const turn = {
      id: turnId,
      speaker: userName || `User ${userId || 'unknown'}`,
      text: String(text || '').trim().slice(0, 4000),
      timestamp: finiteNumber(timestamp, Date.now())
    };
    if (!turn.text) throw new Error('Transcript text is empty');

    session.history.push(turn);
    if (session.history.length > config.historyTurns) session.history.splice(0, session.history.length - config.historyTurns);

    const startedAt = Date.now();
    const raw = await postDecision(config, {
      input: buildDecisionInput(session, turn),
      model: config.model,
      reference_id: turnId,
      questions: Object.entries(COMPLIANCE_QUESTIONS).map(([name, question]) => ({ name, ...question }))
    });
    return {
      ...normalizeComplianceResponse(raw),
      meetingId: meetingId || null,
      latencyMs: Date.now() - startedAt,
      analyzedAt: Date.now(),
      turn
    };
  };

  const result = session.queue.then(work, work);
  session.queue = result.catch(() => undefined);
  return result;
}

export function resetComplianceSession(streamId) {
  if (streamId) sessions.delete(String(streamId));
}

export function resetAllComplianceSessions() {
  sessions.clear();
}
