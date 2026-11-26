import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = 'meta-llama/llama-4-maverick:free';
const DEFAULT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 15000;

let envLoaded = false;

function ensureEnvLoaded() {
  if (envLoaded) return;
  dotenv.config({ path: path.join(__dirname, '.env') });
  envLoaded = true;
}

export function getOpenRouterConfig(overrides = {}) {
  ensureEnvLoaded();
  const apiKey = String(overrides.apiKey ?? process.env.OPENROUTER_API_KEY ?? '').trim();
  const model = String(
    overrides.model || process.env.MODEL_ID || process.env.OPENROUTER_MODEL || DEFAULT_MODEL
  ).trim();
  const endpoint = String(overrides.endpoint || process.env.OPENROUTER_API_URL || DEFAULT_API_URL).trim();
  const timeoutMs = Number(overrides.timeoutMs || process.env.OPENROUTER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  return { apiKey, model, endpoint, timeoutMs };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeConfidence(value, fallback = 'medium') {
  const v = String(value || '').toLowerCase().trim();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return fallback;
}

function parsePlainBullets(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
}

/**
 * Generates a grounded, bullet-point agent-assist answer via OpenRouter.
 * Lazily reads environment configuration and checks HTTP `res.ok`.
 */
export async function chatWithOpenRouter({
  question,
  contextDocs = [],
  conversationContext = [],
  model,
  fetchImpl = globalThis.fetch
}) {
  const config = getOpenRouterConfig({ model });
  if (!config.apiKey || config.apiKey.startsWith('YOUR_')) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const numberedContext = contextDocs
    .map((doc, idx) => {
      const src = doc.metadata?.fileName || doc.metadata?.source || `Source ${idx + 1}`;
      const chunkLabel = Number.isInteger(doc.metadata?.chunkIndex)
        ? ` (chunk ${doc.metadata.chunkIndex + 1})`
        : '';
      return `[${idx + 1}] ${src}${chunkLabel}:\n${doc.pageContent}`;
    })
    .join('\n\n');

  const recentDialogue = conversationContext.length > 0
    ? conversationContext
        .slice(-6)
        .map((turn) => `[${turn.role === 'agent' ? 'Agent' : 'Customer'}] ${turn.userName || 'Speaker'}: ${turn.text}`)
        .join('\n')
    : 'None';

  const systemPrompt = [
    'You are a real-time Customer Support Agent Assist AI.',
    'Answer ONLY using the provided knowledge base sources. Never invent policies, prices, or steps.',
    'Keep each bullet concise and directly usable by a human support agent in a narrow Zoom App sidebar.',
    'Return ONLY valid JSON with this exact schema:',
    '{',
    '  "answerBullets": ["concise grounded bullet referencing source [1]", "..."],',
    '  "confidence": "high" | "medium" | "low",',
    '  "grounded": true | false,',
    '  "citedSources": [1, 2]',
    '}'
  ].join('\n');

  const userPrompt = [
    `Customer question / utterance:\n${question}`,
    `\nRecent conversation context:\n${recentDialogue}`,
    `\nKnowledge base sources:\n${numberedContext || 'No matching sources found.'}`
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://github.com/zoom/rtms-samples',
        'X-Title': 'Zoom RTMS AI RAG Customer Support'
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 450,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${rawText.slice(0, 240)}`);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error('OpenRouter returned invalid JSON');
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('OpenRouter returned an empty response');
    }

    const parsed = extractJsonObject(content);
    if (parsed && Array.isArray(parsed.answerBullets) && parsed.answerBullets.length > 0) {
      const bullets = parsed.answerBullets
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 6);

      const maxIdx = contextDocs.length;
      const citedSources = Array.isArray(parsed.citedSources)
        ? Array.from(new Set(
            parsed.citedSources
              .map((n) => Number(n))
              .filter((n) => Number.isInteger(n) && n >= 1 && n <= maxIdx)
          ))
        : contextDocs.map((_, i) => i + 1);

      return {
        bullets,
        answer: bullets.map((b) => `• ${b}`).join('\n'),
        confidence: normalizeConfidence(parsed.confidence, contextDocs.length > 0 ? 'medium' : 'low'),
        grounded: parsed.grounded !== false && contextDocs.length > 0,
        citedSources,
        model: payload.model || config.model
      };
    }

    const fallbackBullets = parsePlainBullets(content);
    return {
      bullets: fallbackBullets.length > 0 ? fallbackBullets : [content.trim()],
      answer: fallbackBullets.length > 0 ? fallbackBullets.map((b) => `• ${b}`).join('\n') : content.trim(),
      confidence: contextDocs.length > 0 ? 'medium' : 'low',
      grounded: contextDocs.length > 0,
      citedSources: contextDocs.map((_, i) => i + 1),
      model: payload.model || config.model
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`OpenRouter request timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
