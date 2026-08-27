import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import {
  ProviderControlError,
  ProviderRequestControls,
  readProviderNumber
} from '../../library/javascript/commonHelpers/providerRequestControls.js';

dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });

const SYSTEM_INSTRUCTIONS = 'You are a helpful assistant. Analyze or respond based on the provided meeting transcript.';

export const claudeConfig = Object.freeze({
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  timeoutMs: readProviderNumber('CLAUDE_TIMEOUT_MS', 20_000, { integer: true, minimum: 1 }),
  maxRetries: readProviderNumber('CLAUDE_MAX_RETRIES', 2, { integer: true }),
  maxOutputTokens: readProviderNumber('CLAUDE_MAX_OUTPUT_TOKENS', 512, { integer: true, minimum: 1 }),
  maxInputCharacters: readProviderNumber('CLAUDE_MAX_INPUT_CHARACTERS', 40_000, { integer: true, minimum: 1 }),
  maxHistoryMessages: readProviderNumber('CLAUDE_MAX_HISTORY_MESSAGES', 20, { integer: true, minimum: 2 }),
  maxHistoryCharacters: readProviderNumber('CLAUDE_MAX_HISTORY_CHARACTERS', 40_000, { integer: true, minimum: 1 }),
  maxRequestsPerMinute: readProviderNumber('CLAUDE_MAX_REQUESTS_PER_MINUTE', 30, { integer: true }),
  maxRequestsPerStream: readProviderNumber('CLAUDE_MAX_REQUESTS_PER_STREAM', 300, { integer: true }),
  maxSpendUsdPerStream: readProviderNumber('CLAUDE_MAX_SPEND_USD_PER_STREAM', 1),
  inputCostPerMillionTokens: readProviderNumber('CLAUDE_INPUT_COST_PER_MILLION_TOKENS', 2),
  outputCostPerMillionTokens: readProviderNumber('CLAUDE_OUTPUT_COST_PER_MILLION_TOKENS', 10)
});

export function createClaudeService({ client, config = claudeConfig } = {}) {
  const sessions = new Map();
  const controls = new ProviderRequestControls({ provider: 'Claude', ...config });
  let anthropic = client;

  function getClient() {
    if (!anthropic) {
      anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: config.timeoutMs,
        maxRetries: config.maxRetries
      });
    }
    return anthropic;
  }

  function getSession(streamId) {
    const normalizedStreamId = String(streamId || '').trim();
    if (!sessions.has(normalizedStreamId)) {
      sessions.set(normalizedStreamId, { history: [], queue: Promise.resolve() });
    }
    return sessions.get(normalizedStreamId);
  }

  function trimHistory(history) {
    const characterCount = () => history.reduce((total, message) => total + message.content.length, 0);
    while (
      history.length > 2 &&
      (history.length > config.maxHistoryMessages || characterCount() > config.maxHistoryCharacters)
    ) {
      history.splice(0, Math.min(2, history.length - 1));
    }
  }

  async function send(userMessage, streamId) {
    const normalizedStreamId = String(streamId || '').trim();
    const normalizedMessage = String(userMessage || '').trim();
    if (!normalizedStreamId) {
      throw new ProviderControlError(
        'missing_stream_id',
        'Claude request requires an RTMS stream ID.',
        'Pass event.streamId from the RTMS transcript event.'
      );
    }
    if (!normalizedMessage) {
      throw new ProviderControlError(
        'empty_input',
        'Claude request has no transcript text.',
        'Wait for a non-empty RTMS transcript event before calling the provider.'
      );
    }
    const session = getSession(normalizedStreamId);
    const operation = session.queue.catch(() => {}).then(async () => {
      const userEntry = { role: 'user', content: normalizedMessage };
      session.history.push(userEntry);
      trimHistory(session.history);
      let reservation;

      try {
        const requestContext = [
          SYSTEM_INSTRUCTIONS,
          ...session.history.map((message) => message.content)
        ].join('\n');
        reservation = controls.reserve(normalizedStreamId, requestContext, config.maxOutputTokens);
        const response = await getClient().messages.create({
          model: config.model,
          system: SYSTEM_INSTRUCTIONS,
          max_tokens: config.maxOutputTokens,
          messages: session.history
        });
        const assistantMessage = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n') || '(no text response)';

        session.history.push({ role: 'assistant', content: assistantMessage });
        trimHistory(session.history);
        controls.complete(reservation, {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens
        });
        return assistantMessage;
      } catch (error) {
        if (session.history.at(-1) === userEntry) session.history.pop();
        if (reservation) controls.fail(reservation);
        throw error;
      }
    });

    session.queue = operation.catch(() => {});
    return operation;
  }

  function clearStream(streamId) {
    sessions.delete(String(streamId || '').trim());
    controls.clearStream(streamId);
  }

  return {
    chatWithClaude: send,
    clearClaudeStream: clearStream,
    getSessionHistory: (streamId) => [...(sessions.get(String(streamId || '').trim())?.history || [])]
  };
}

const defaultService = createClaudeService();
export const chatWithClaude = defaultService.chatWithClaude;
export const clearClaudeStream = defaultService.clearClaudeStream;
