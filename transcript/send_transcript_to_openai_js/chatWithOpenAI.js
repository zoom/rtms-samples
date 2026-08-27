import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import {
  ProviderControlError,
  ProviderRequestControls,
  readProviderNumber
} from '../../library/javascript/commonHelpers/providerRequestControls.js';

dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });

const SYSTEM_INSTRUCTIONS = 'You are a helpful assistant. Analyze or respond based on the provided meeting transcript.';

export const openAIConfig = Object.freeze({
  model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  timeoutMs: readProviderNumber('OPENAI_TIMEOUT_MS', 20_000, { integer: true, minimum: 1 }),
  maxRetries: readProviderNumber('OPENAI_MAX_RETRIES', 2, { integer: true }),
  maxOutputTokens: readProviderNumber('OPENAI_MAX_OUTPUT_TOKENS', 512, { integer: true, minimum: 1 }),
  maxInputCharacters: readProviderNumber('OPENAI_MAX_INPUT_CHARACTERS', 12_000, { integer: true, minimum: 1 }),
  maxRequestsPerMinute: readProviderNumber('OPENAI_MAX_REQUESTS_PER_MINUTE', 30, { integer: true }),
  maxRequestsPerStream: readProviderNumber('OPENAI_MAX_REQUESTS_PER_STREAM', 300, { integer: true }),
  maxSpendUsdPerStream: readProviderNumber('OPENAI_MAX_SPEND_USD_PER_STREAM', 1),
  inputCostPerMillionTokens: readProviderNumber('OPENAI_INPUT_COST_PER_MILLION_TOKENS', 0.4),
  outputCostPerMillionTokens: readProviderNumber('OPENAI_OUTPUT_COST_PER_MILLION_TOKENS', 1.6)
});

const controls = new ProviderRequestControls({ provider: 'OpenAI', ...openAIConfig });
let openai;

function getClient() {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: openAIConfig.timeoutMs,
      maxRetries: openAIConfig.maxRetries
    });
  }
  return openai;
}

export async function chatWithTranscript(transcriptText, streamId) {
  const transcript = String(transcriptText || '').trim();
  if (!transcript) {
    throw new ProviderControlError(
      'empty_input',
      'OpenAI request has no transcript text.',
      'Wait for a non-empty RTMS transcript event before calling the provider.'
    );
  }
  const input = `Transcript:\n\n${transcript}`;
  const reservation = controls.reserve(
    streamId,
    `${SYSTEM_INSTRUCTIONS}\n${input}`,
    openAIConfig.maxOutputTokens
  );
  try {
    const response = await getClient().responses.create({
      model: openAIConfig.model,
      instructions: SYSTEM_INSTRUCTIONS,
      input,
      max_output_tokens: openAIConfig.maxOutputTokens
    });

    controls.complete(reservation, {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    });
    return response.output_text || '(no text response)';
  } catch (error) {
    controls.fail(reservation);
    throw error;
  }
}

export function clearOpenAIStream(streamId) {
  controls.clearStream(streamId);
}
