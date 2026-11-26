import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

/**
 * Calls OpenRouter chat completions with a proper messages array.
 * Reads OPENROUTER_MODEL and OPENROUTER_API_KEY lazily and checks `res.ok`.
 *
 * @param {Array<{role: string, content: string}>|string} messagesOrPrompt
 * @param {Object|string} [options]
 * @returns {Promise<string>}
 */
export async function chatWithOpenRouter(messagesOrPrompt, options = {}) {
  const {
    model = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    apiKey = process.env.OPENROUTER_API_KEY,
    temperature = 0.8,
    fetchImpl = fetch
  } = typeof options === 'string' ? { model: options } : options;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const messages = Array.isArray(messagesOrPrompt)
    ? messagesOrPrompt.map((m) => ({
        role: String(m.role || 'user'),
        content: String(m.content || '')
      }))
    : [{ role: 'user', content: String(messagesOrPrompt || '') }];

  const res = await fetchImpl(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature
    })
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error (${res.status}): ${errorText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned an empty response');
  }

  return content.trim();
}
