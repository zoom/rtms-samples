const DEFAULT_ENDPOINT = 'https://api.zoom.us/v2/aiservices/decisions/decide';
const DEFAULT_MODEL = 'zoom-decisions';
const DEFAULT_HISTORY_TURNS = 12;
const DEFAULT_TIMEOUT_MS = 10000;

const sessions = new Map();

export const SALES_QUESTIONS = Object.freeze({
  buyer_intent: {
    type: 'choice',
    instructions: 'Choose the primary intent expressed in the latest buyer turn.',
    choices: [
      { value: 'discovery', description: 'Explaining the current process, problem, requirement, or desired outcome.' },
      { value: 'pricing', description: 'Asking about price, packaging, licensing, or commercial terms.' },
      { value: 'technical', description: 'Asking about product behavior, architecture, integrations, or implementation.' },
      { value: 'security', description: 'Asking about privacy, security, compliance, data handling, or risk review.' },
      { value: 'timeline', description: 'Discussing deadlines, rollout timing, urgency, or project sequencing.' },
      { value: 'authority', description: 'Discussing decision makers, approvals, stakeholders, or procurement ownership.' },
      { value: 'objection', description: 'Expressing a concern, blocker, disagreement, or reason not to proceed.' },
      { value: 'commitment', description: 'Agreeing to a concrete next step, evaluation, purchase, or follow-up.' },
      { value: 'small_talk', description: 'Rapport-building or conversation unrelated to the opportunity.' },
      { value: 'unclear', description: 'The intent cannot be reliably determined from the available context.' }
    ]
  },
  objection: {
    type: 'choice',
    instructions: 'Choose the main objection in the latest buyer turn, or no_objection.',
    choices: [
      { value: 'no_objection', description: 'No meaningful objection is expressed.' },
      { value: 'price', description: 'The offering appears too expensive or poor value.' },
      { value: 'budget', description: 'Funds are unavailable, unapproved, or allocated elsewhere.' },
      { value: 'timing', description: 'The buyer is not ready or has competing timing priorities.' },
      { value: 'authority', description: 'The speaker cannot approve or needs another stakeholder.' },
      { value: 'need', description: 'The problem is not important enough or the status quo is acceptable.' },
      { value: 'trust', description: 'The buyer doubts claims, reliability, vendor maturity, or proof.' },
      { value: 'competition', description: 'The buyer prefers or is evaluating another solution.' },
      { value: 'technical', description: 'A capability, integration, architecture, or implementation concern blocks progress.' },
      { value: 'security', description: 'Security, privacy, legal, or compliance concerns block progress.' }
    ]
  },
  deal_stage: {
    type: 'choice',
    instructions: 'Choose the sales stage best supported by the conversation context.',
    choices: [
      { value: 'rapport', description: 'Introductions and relationship building before substantive discovery.' },
      { value: 'discovery', description: 'Understanding problems, impact, requirements, and success criteria.' },
      { value: 'solution_fit', description: 'Mapping capabilities or a demonstration to stated needs.' },
      { value: 'evaluation', description: 'Technical, security, legal, or stakeholder evaluation is underway.' },
      { value: 'negotiation', description: 'Commercial terms, pricing, procurement, or contract details are being discussed.' },
      { value: 'closing', description: 'The parties are confirming commitment and concrete purchase steps.' },
      { value: 'follow_up', description: 'The current discussion is primarily coordinating work after this conversation.' }
    ]
  },
  next_action: {
    type: 'choice',
    instructions: 'Choose the single best next move for the seller after the latest buyer turn.',
    choices: [
      { value: 'ask_discovery_question', description: 'Ask an open question to understand the buyer situation or desired outcome.' },
      { value: 'clarify_need', description: 'Clarify an ambiguous requirement, concern, or statement before responding.' },
      { value: 'quantify_impact', description: 'Explore measurable business impact, cost, frequency, or urgency.' },
      { value: 'address_objection', description: 'Acknowledge and directly work through the buyer concern.' },
      { value: 'share_proof', description: 'Offer relevant evidence, a customer example, benchmark, or validation step.' },
      { value: 'confirm_stakeholders', description: 'Identify decision makers, evaluators, approvers, or procurement participants.' },
      { value: 'propose_next_step', description: 'Suggest a specific mutually agreed follow-up with an owner and timing.' },
      { value: 'recap', description: 'Confirm the understood needs, decisions, and open questions.' },
      { value: 'pause_and_listen', description: 'Avoid adding a pitch; give the buyer room to continue.' }
    ]
  },
  purchase_signal: {
    type: 'predicate',
    instructions: 'The latest buyer turn contains a concrete signal of willingness to evaluate, advance, or buy.'
  },
  deal_risk: {
    type: 'score',
    instructions: 'Score the current risk that this opportunity stalls or is lost.',
    levels: [
      { label: 'Low', description: 'Engaged buyer, clear fit, and constructive progress.' },
      { label: 'Minor', description: 'Missing information but no material blocker.' },
      { label: 'Moderate', description: 'Unresolved concern, weak urgency, or unclear process.' },
      { label: 'High', description: 'Substantial blocker, skepticism, or stalled momentum.' },
      { label: 'Critical', description: 'Explicit rejection, churn from the process, or no viable path forward.' }
    ]
  }
});

const ACTION_GUIDANCE = Object.freeze({
  ask_discovery_question: ['Ask a discovery question', 'Could you walk me through how this works today and where the biggest friction is?'],
  clarify_need: ['Clarify the need', 'When you say that is important, what would a successful outcome look like for your team?'],
  quantify_impact: ['Quantify the impact', 'How often does this happen, and what does it cost the team when it does?'],
  address_objection: ['Address the objection', 'That concern makes sense. What would need to be true for you to feel comfortable moving forward?'],
  share_proof: ['Share relevant proof', 'Would it help if I showed how a similar team validated this requirement and measured the result?'],
  confirm_stakeholders: ['Confirm stakeholders', 'Who else should be involved in evaluating this and approving the next step?'],
  propose_next_step: ['Propose a concrete next step', 'Would it make sense to schedule the next review now, with the right stakeholders and a clear evaluation goal?'],
  recap: ['Recap and confirm', 'Let me confirm what I heard: the priority is the outcome we discussed, and the remaining question is how we validate it. Is that accurate?'],
  pause_and_listen: ['Pause and listen', 'Give the buyer space to finish before adding another question or pitch.']
});

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function getHistoryLimit() {
  return positiveInteger(process.env.SALES_HISTORY_TURNS, DEFAULT_HISTORY_TURNS, 'SALES_HISTORY_TURNS');
}

function getConfig() {
  const apiKey = String(process.env.ZOOM_AI_SERVICES_API_KEY || '').trim();
  if (!apiKey) throw new Error('ZOOM_AI_SERVICES_API_KEY is required');
  return {
    apiKey,
    endpoint: process.env.ZOOM_DECISIONS_URL || DEFAULT_ENDPOINT,
    model: process.env.ZOOM_DECISIONS_MODEL || DEFAULT_MODEL,
    historyTurns: getHistoryLimit(),
    timeoutMs: positiveInteger(process.env.ZOOM_DECISIONS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'ZOOM_DECISIONS_TIMEOUT_MS')
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRole(role) {
  return String(role || '').toLowerCase() === 'seller' ? 'seller' : 'buyer';
}

export function formatTaggedSpeaker(userName, userId, role) {
  const cleanName = String(userName || `User ${userId || 'unknown'}`).replace(/^\[(Buyer|Seller)\]\s*/i, '').trim();
  const tag = normalizeRole(role) === 'seller' ? '[Seller]' : '[Buyer]';
  return `${tag} ${cleanName}`;
}

function probabilityMap(entries) {
  if (Array.isArray(entries)) {
    return Object.fromEntries(entries.map((entry) => [String(entry.value), finiteNumber(entry.probability)]));
  }
  if (entries && typeof entries === 'object') {
    return Object.fromEntries(Object.entries(entries).map(([k, v]) => [String(k), finiteNumber(v)]));
  }
  return {};
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

export function buildSalesDecisionInput(history, latestTurn, salesContext = process.env.SALES_CONTEXT) {
  const contextLine = salesContext || 'B2B software sales conversation';
  const lines = (Array.isArray(history) ? history : []).map((turn) => `${turn.speaker}: ${turn.text}`);
  return [
    `Sales conversation context: ${contextLine}`,
    '',
    'Recent transcript, oldest first:',
    ...lines,
    '',
    `Latest buyer speaker: ${latestTurn.speaker}`,
    `Latest buyer utterance: ${latestTurn.text}`
  ].join('\n');
}

export function normalizeSalesDecisionResponse(payload) {
  const answers = Array.isArray(payload?.answers) ? payload.answers : null;
  if (!answers) throw new Error('Zoom Decisions response did not include an answers array');

  const byName = Object.fromEntries(answers.map((answer) => [answer.name, answer]));
  if (answers.some((answer) => answer.type === 'refusal')) {
    throw new Error('Zoom Decisions returned a refusal');
  }

  const nextAction = normalizeChoice(byName.next_action);
  const guidance = ACTION_GUIDANCE[nextAction.value] || ACTION_GUIDANCE.clarify_need;
  const actionOptions = buildActionOptions(byName.next_action, nextAction.value);
  return {
    model: payload.model || null,
    requestId: payload.request_id || null,
    buyerIntent: normalizeChoice(byName.buyer_intent),
    objection: normalizeChoice(byName.objection),
    dealStage: normalizeChoice(byName.deal_stage),
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
    purchaseSignal: finiteNumber(byName.purchase_signal?.probability),
    dealRisk: normalizeScore(byName.deal_risk),
    usage: payload.usage || null
  };
}

async function postDecision(config, body, fetchImpl = globalThis.fetch) {
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

function sessionFor(streamId) {
  const key = String(streamId || 'unknown-stream');
  if (!sessions.has(key)) {
    sessions.set(key, {
      history: [],
      inFlight: false,
      pendingTask: null
    });
  }
  return sessions.get(key);
}

/**
 * Records or updates a turn in the stream's rolling history (including short turns
 * like "Yes.", "$50k", "Q3", Seller turns, and transcript rewind updates) without
 * calling the Zoom Decisions API.
 */
export function recordSalesTurn({ turnId, streamId, userId, userName, role = 'buyer', text, timestamp }) {
  const trimmedText = String(text || '').trim().slice(0, 4000);
  if (!trimmedText) return null;

  const session = sessionFor(streamId);
  const resolvedRole = normalizeRole(role);
  const rawName = String(userName || `User ${userId || 'unknown'}`).trim();
  const turn = {
    id: turnId,
    userId: userId ?? null,
    userName: rawName,
    role: resolvedRole,
    speaker: formatTaggedSpeaker(rawName, userId, resolvedRole),
    text: trimmedText,
    timestamp: finiteNumber(timestamp, Date.now())
  };

  const existingIdx = turnId != null ? session.history.findIndex((item) => item.id === turnId) : -1;
  if (existingIdx !== -1) {
    session.history[existingIdx] = {
      ...session.history[existingIdx],
      ...turn,
      timestamp: session.history[existingIdx].timestamp
    };
  } else {
    session.history.push(turn);
    const limit = getHistoryLimit();
    if (session.history.length > limit) {
      session.history.splice(0, session.history.length - limit);
    }
  }

  return turn;
}

/**
 * Updates `[Buyer]` / `[Seller]` tags on existing turns in a stream's history when
 * a speaker's role is changed.
 */
export function updateHistorySpeakerRole(streamId, { userId, userName, role }) {
  const session = sessions.get(String(streamId || ''));
  if (!session) return;
  const resolvedRole = normalizeRole(role);
  const normId = userId != null ? String(userId).trim().toLowerCase() : '';
  const normName = userName ? String(userName).trim().toLowerCase() : '';

  for (const turn of session.history) {
    const matchId = normId && turn.userId != null && String(turn.userId).trim().toLowerCase() === normId;
    const matchName = normName && turn.userName && String(turn.userName).trim().toLowerCase() === normName;
    if (matchId || matchName) {
      turn.role = resolvedRole;
      turn.speaker = formatTaggedSpeaker(turn.userName, turn.userId, resolvedRole);
    }
  }
}

export function getSalesSessionHistory(streamId) {
  const session = sessions.get(String(streamId || ''));
  return session ? session.history.map((t) => ({ ...t })) : [];
}

async function drainSessionQueue(streamKey, session) {
  if (session.inFlight) return;

  while (session.pendingTask && sessions.has(streamKey)) {
    const task = session.pendingTask;
    session.pendingTask = null;
    session.inFlight = true;

    try {
      const config = getConfig();
      const historySnapshot = session.history.slice(-config.historyTurns);
      const input = buildSalesDecisionInput(historySnapshot, task.turn);

      const startedAt = Date.now();
      const raw = await postDecision(
        config,
        {
          input,
          model: config.model,
          reference_id: task.turn.id,
          questions: Object.entries(SALES_QUESTIONS).map(([name, question]) => ({ name, ...question }))
        },
        task.fetchImpl
      );

      task.resolve({
        ...normalizeSalesDecisionResponse(raw),
        meetingId: task.meetingId || null,
        latencyMs: Date.now() - startedAt,
        analyzedAt: Date.now(),
        turn: task.turn
      });
    } catch (err) {
      task.reject(err);
    } finally {
      session.inFlight = false;
    }
  }
}

/**
 * Evaluates a buyer turn with Zoom Decisions, bounding queued requests to at most
 * 1 pending slot per stream (coalescing bursty speech so latency stays bounded).
 * Skips redundant inference if role === 'seller'.
 */
export function analyzeSalesTurn({
  turnId,
  streamId,
  meetingId,
  userId,
  userName,
  role = 'buyer',
  text,
  timestamp,
  fetchImpl = globalThis.fetch
}) {
  const turn = recordSalesTurn({ turnId, streamId, userId, userName, role, text, timestamp });
  if (!turn) {
    return Promise.reject(new Error('Transcript text is empty'));
  }

  if (turn.role === 'seller') {
    return Promise.resolve({
      skipped: true,
      reason: 'seller_turn',
      turnId: turn.id,
      turn
    });
  }

  const streamKey = String(streamId || 'unknown-stream');
  const session = sessionFor(streamKey);

  return new Promise((resolve, reject) => {
    if (session.pendingTask) {
      session.pendingTask.resolve({
        skipped: true,
        reason: 'superseded',
        turnId: session.pendingTask.turn.id,
        turn: session.pendingTask.turn
      });
    }

    session.pendingTask = {
      meetingId,
      turn,
      fetchImpl,
      resolve,
      reject
    };

    drainSessionQueue(streamKey, session);
  });
}

export function resetSalesSession(streamId) {
  if (!streamId) return;
  const key = String(streamId);
  const session = sessions.get(key);
  if (session?.pendingTask) {
    session.pendingTask.resolve({
      skipped: true,
      reason: 'session_reset',
      turnId: session.pendingTask.turn.id,
      turn: session.pendingTask.turn
    });
    session.pendingTask = null;
  }
  sessions.delete(key);
}

export function resetAllSalesSessions() {
  for (const key of Array.from(sessions.keys())) {
    resetSalesSession(key);
  }
}
