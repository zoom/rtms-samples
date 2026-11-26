import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

export const VOICE_ASSISTANT_SYSTEM_PROMPT =
  'You are a concise, helpful real-time voice assistant inside a Zoom meeting. ' +
  'Respond naturally in 1 to 2 short spoken sentences (roughly 15-35 words) without markdown formatting or bullet points.';

/**
 * Sends a single prompt or conversation history array to OpenRouter.
 * @param {string|Array<{role: string, content: string}>} input
 * @param {Object} [options]
 * @param {string} [options.model]
 * @param {string} [options.apiKey]
 * @param {string} [options.systemPrompt]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<string>}
 */
export async function chatWithOpenRouter(input, options = {}) {
  const {
    model = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    apiKey = process.env.OPENROUTER_API_KEY,
    systemPrompt = VOICE_ASSISTANT_SYSTEM_PROMPT,
    signal,
    fetchImpl = fetch
  } = typeof options === 'string' ? { model: options } : options;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  let messages;
  if (Array.isArray(input)) {
    const hasSystem = input.some((m) => m.role === 'system');
    messages = hasSystem
      ? input
      : [{ role: 'system', content: systemPrompt }, ...input];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(input || '') }
    ];
  }

  const res = await fetchImpl(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages
    }),
    signal
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error (${res.status}): ${errorBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned an empty response');
  }

  return content.trim();
}
