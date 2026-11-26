const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const DEFAULT_HISTORY_TURNS = 12;
const DEFAULT_TIMEOUT_MS = 10000;

const sessions = new Map();

export const SALES_QUESTIONS = Object.freeze({
  buyer_intent: {
    type: 'choice',
    instructions: 'Choose the primary intent expressed in the latest buyer turn.',
    criteria: {
      discovery: 'Explaining the current process, problem, requirement, or desired outcome.',
      pricing: 'Asking about price, packaging, licensing, or commercial terms.',
      technical: 'Asking about product behavior, architecture, integrations, or implementation.',
      security: 'Asking about privacy, security, compliance, data handling, or risk review.',
      timeline: 'Discussing deadlines, rollout timing, urgency, or project sequencing.',
      authority: 'Discussing decision makers, approvals, stakeholders, or procurement ownership.',
      objection: 'Expressing a concern, blocker, disagreement, or reason not to proceed.',
      commitment: 'Agreeing to a concrete next step, evaluation, purchase, or follow-up.',
      small_talk: 'Rapport-building or conversation unrelated to the opportunity.',
      unclear: 'The intent cannot be reliably determined from the available context.'
    }
  },
  objection: {
    type: 'choice',
    instructions: 'Choose the main objection in the latest buyer turn, or no_objection.',
    criteria: {
      no_objection: 'No meaningful objection is expressed.',
      price: 'The offering appears too expensive or poor value.',
      budget: 'Funds are unavailable, unapproved, or allocated elsewhere.',
      timing: 'The buyer is not ready or has competing timing priorities.',
      authority: 'The speaker cannot approve or needs another stakeholder.',
      need: 'The problem is not important enough or the status quo is acceptable.',
      trust: 'The buyer doubts claims, reliability, vendor maturity, or proof.',
      competition: 'The buyer prefers or is evaluating another solution.',
      technical: 'A capability, integration, architecture, or implementation concern blocks progress.',
      security: 'Security, privacy, legal, or compliance concerns block progress.'
    }
  },
  deal_stage: {
    type: 'choice',
    instructions: 'Choose the sales stage best supported by the conversation context.',
    criteria: {
      rapport: 'Introductions and relationship building before substantive discovery.',
      discovery: 'Understanding problems, impact, requirements, and success criteria.',
      solution_fit: 'Mapping capabilities or a demonstration to stated needs.',
      evaluation: 'Technical, security, legal, or stakeholder evaluation is underway.',
      negotiation: 'Commercial terms, pricing, procurement, or contract details are being discussed.',
      closing: 'The parties are confirming commitment and concrete purchase steps.',
      follow_up: 'The current discussion is primarily coordinating work after this conversation.'
    }
  },
  next_action: {
    type: 'choice',
    instructions: 'Choose the single best next move for the seller after the latest buyer turn.',
    criteria: {
      ask_discovery_question: 'Ask an open question to understand the buyer situation or desired outcome.',
      clarify_need: 'Clarify an ambiguous requirement, concern, or statement before responding.',
      quantify_impact: 'Explore measurable business impact, cost, frequency, or urgency.',
      address_objection: 'Acknowledge and directly work through the buyer concern.',
      share_proof: 'Offer relevant evidence, a customer example, benchmark, or validation step.',
      confirm_stakeholders: 'Identify decision makers, evaluators, approvers, or procurement participants.',
      propose_next_step: 'Suggest a specific mutually agreed follow-up with an owner and timing.',
      recap: 'Confirm the understood needs, decisions, and open questions.',
      pause_and_listen: 'Avoid adding a pitch; give the buyer room to continue.'
    }
  },
  purchase_signal: {
    type: 'noul',
    instructions: 'The latest buyer turn contains a concrete signal of willingness to evaluate, advance, or buy.'
  },
  deal_risk: {
    type: 'score',
    instructions: 'Score the current risk that this opportunity stalls or is lost.',
    criteria: [
      'Low risk: engaged buyer, clear fit, and constructive progress.',
      'Some uncertainty: missing information but no material blocker.',
      'Moderate risk: unresolved concern, weak urgency, or unclear process.',
      'High risk: a substantial blocker, skepticism, or stalled momentum.',
      'Critical risk: explicit rejection, churn from the process, or no viable path forward.'
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
  return positiveInteger(process.env.JEV_HISTORY_TURNS, DEFAULT_HISTORY_TURNS, 'JEV_HISTORY_TURNS');
}

function getConfig() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  return {
    apiKey,
    endpoint: process.env.JEV_DECISIONS_URL || DEFAULT_ENDPOINT,
    model: process.env.JEV_MODEL || DEFAULT_MODEL,
    historyTurns: getHistoryLimit(),
    timeoutMs: positiveInteger(process.env.JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'JEV_TIMEOUT_MS')
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

function normalizeChoice(answer = {}) {
  return {
    value: String(answer.choice || 'unclear'),
    confidence: finiteNumber(answer.confidence),
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  };
}

function normalizeScore(answer = {}) {
  return {
    value: finiteNumber(answer.score),
    confidence: finiteNumber(answer.confidence),
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  };
}

function buildActionOptions(answer, selectedValue) {
  const ranked = Object.entries(answer?.probabilities || {})
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

export function normalizeJevResponse(payload) {
  const answers = payload?.answers;
  if (!answers || typeof answers !== 'object') throw new Error('Jev response did not include an answers object');

  const nextAction = normalizeChoice(answers.next_action);
  const guidance = ACTION_GUIDANCE[nextAction.value] || ACTION_GUIDANCE.clarify_need;
  const actionOptions = buildActionOptions(answers.next_action, nextAction.value);
  return {
    model: payload.model || null,
    buyerIntent: normalizeChoice(answers.buyer_intent),
    objection: normalizeChoice(answers.objection),
    dealStage: normalizeChoice(answers.deal_stage),
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
    purchaseSignal: finiteNumber(answers.purchase_signal?.noul),
    dealRisk: normalizeScore(answers.deal_risk),
    usage: payload.usage || null
  };
}

async function postDecision(config, body, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://github.com/zoom/rtms-samples',
        'X-Title': 'Zoom RTMS Jev Sales Conversation Copilot'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenRouter Decisions API returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('OpenRouter Decisions API returned invalid JSON');
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Jev request timed out after ${config.timeoutMs}ms`);
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
      pendingTask: null // bounded single-slot coalescing queue
    });
  }
  return sessions.get(key);
}

/**
 * Records or updates a turn in the stream's rolling history (including short turns
 * like "Yes.", "$50k", "Q3", Seller turns, and transcript rewind updates) without
 * calling the Jev API.
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
      const historySnapshot = session.history.map((t) => ({
        id: t.id,
        role: t.role,
        speaker: t.speaker,
        text: t.text,
        timestamp: t.timestamp
      }));

      const startedAt = Date.now();
      const raw = await postDecision(
        config,
        {
          model: config.model,
          state: {
            meeting: { id: task.meetingId || null },
            sales_context: process.env.SALES_CONTEXT || 'B2B software sales conversation',
            latest_turn: {
              id: task.turn.id,
              role: task.turn.role,
              speaker: task.turn.speaker,
              text: task.turn.text,
              timestamp: task.turn.timestamp
            },
            recent_turns: historySnapshot
          },
          questions: SALES_QUESTIONS
        },
        task.fetchImpl
      );

      task.resolve({
        ...normalizeJevResponse(raw),
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
 * Evaluates a buyer turn with Jev, bounding queued requests to at most 1 pending
 * slot per stream (coalescing bursty speech so latency never grows unbounded).
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
    // Coalesce: if another request is already queued waiting behind an in-flight call,
    // supersede it cleanly (its turn remains recorded in session.history!).
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
