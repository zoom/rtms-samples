const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;

export class ProviderControlError extends Error {
  constructor(code, message, action) {
    super(message);
    this.name = 'ProviderControlError';
    this.code = code;
    this.action = action;
    this.retryable = false;
  }
}

export class ProviderRequestControls {
  constructor({
    provider,
    maxInputCharacters,
    maxRequestsPerMinute,
    maxRequestsPerStream,
    maxSpendUsdPerStream,
    inputCostPerMillionTokens,
    outputCostPerMillionTokens,
    now = () => Date.now()
  }) {
    this.provider = provider;
    this.maxInputCharacters = maxInputCharacters;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.maxRequestsPerStream = maxRequestsPerStream;
    this.maxSpendUsdPerStream = maxSpendUsdPerStream;
    this.inputCostPerMillionTokens = inputCostPerMillionTokens;
    this.outputCostPerMillionTokens = outputCostPerMillionTokens;
    this.now = now;
    this.requestTimes = [];
    this.streams = new Map();
  }

  reserve(streamId, input, maxOutputTokens) {
    const normalizedStreamId = String(streamId || '').trim();
    const normalizedInput = String(input || '');
    if (!normalizedStreamId) {
      throw new ProviderControlError(
        'missing_stream_id',
        `${this.provider} request requires an RTMS stream ID.`,
        'Pass event.streamId from the RTMS transcript event.'
      );
    }

    if (!normalizedInput.trim()) {
      throw new ProviderControlError(
        'empty_input',
        `${this.provider} request has no transcript text.`,
        'Wait for a non-empty RTMS transcript event before calling the provider.'
      );
    }

    if (normalizedInput.length > this.maxInputCharacters) {
      throw new ProviderControlError(
        'input_too_large',
        `${this.provider} input exceeds ${this.maxInputCharacters} characters.`,
        'Reduce the transcript segment size or increase the configured input limit.'
      );
    }

    const now = this.now();
    this.requestTimes = this.requestTimes.filter((timestamp) => now - timestamp < 60_000);
    if (this.maxRequestsPerMinute > 0 && this.requestTimes.length >= this.maxRequestsPerMinute) {
      throw new ProviderControlError(
        'local_rate_limit',
        `${this.provider} local request rate limit was reached.`,
        'Wait for the next one-minute window or raise the configured request limit.'
      );
    }

    const stream = this.streams.get(normalizedStreamId) || {
      requests: 0,
      spentUsd: 0,
      reservedUsd: 0
    };
    if (this.maxRequestsPerStream > 0 && stream.requests >= this.maxRequestsPerStream) {
      throw new ProviderControlError(
        'stream_request_limit',
        `${this.provider} request limit was reached for this RTMS stream.`,
        'Start a new stream or raise the configured per-stream request limit.'
      );
    }

    const estimatedInputTokens = Math.ceil(normalizedInput.length / APPROXIMATE_CHARACTERS_PER_TOKEN);
    const estimatedCostUsd = this.calculateCost(estimatedInputTokens, maxOutputTokens);
    if (
      this.maxSpendUsdPerStream > 0 &&
      stream.spentUsd + stream.reservedUsd + estimatedCostUsd > this.maxSpendUsdPerStream
    ) {
      throw new ProviderControlError(
        'stream_spend_limit',
        `${this.provider} estimated spend limit was reached for this RTMS stream.`,
        'Review provider usage or raise the configured per-stream spend limit.'
      );
    }

    this.requestTimes.push(now);
    stream.requests += 1;
    stream.reservedUsd += estimatedCostUsd;
    this.streams.set(normalizedStreamId, stream);

    return { streamId: normalizedStreamId, estimatedCostUsd };
  }

  complete(reservation, { inputTokens = 0, outputTokens = 0 } = {}) {
    const stream = this.streams.get(reservation.streamId);
    if (!stream) return;
    stream.reservedUsd = Math.max(0, stream.reservedUsd - reservation.estimatedCostUsd);
    stream.spentUsd += this.calculateCost(inputTokens, outputTokens);
  }

  fail(reservation) {
    const stream = this.streams.get(reservation.streamId);
    if (!stream) return;
    stream.reservedUsd = Math.max(0, stream.reservedUsd - reservation.estimatedCostUsd);
  }

  clearStream(streamId) {
    this.streams.delete(String(streamId || '').trim());
  }

  calculateCost(inputTokens, outputTokens) {
    return (
      inputTokens * this.inputCostPerMillionTokens +
      outputTokens * this.outputCostPerMillionTokens
    ) / 1_000_000;
  }
}

export function readProviderNumber(name, fallback, { integer = false, minimum = 0 } = {}) {
  const value = process.env[name];
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} greater than or equal to ${minimum}.`);
  }
  return parsed;
}

export function sanitizeProviderError(provider, error) {
  if (error instanceof ProviderControlError) {
    return {
      provider,
      code: error.code,
      message: error.message,
      action: error.action,
      retryable: false
    };
  }

  const status = Number(error?.status || error?.response?.status) || undefined;
  const requestId = error?.request_id || error?._request_id || error?.headers?.get?.('x-request-id');
  let code = 'provider_request_failed';
  let message = `${provider} request failed.`;
  let action = 'Retry later and use the provider request ID when contacting support.';
  let retryable = false;

  if (status === 401) {
    code = 'authentication_failed';
    message = `${provider} rejected the API credentials.`;
    action = `Verify the ${provider} API key configured for this service.`;
  } else if (status === 400) {
    code = 'invalid_provider_request';
    message = `${provider} rejected the request configuration.`;
    action = 'Verify the configured model, token limits, and input size.';
  } else if (status === 403 || status === 404) {
    code = 'model_access_denied';
    message = `${provider} denied access to the configured model.`;
    action = 'Verify the model name and that the API account can use it.';
  } else if (status === 429) {
    code = 'provider_rate_limited';
    message = `${provider} rate limit or quota was reached.`;
    action = 'Reduce request frequency or review provider quota and billing.';
    retryable = true;
  } else if (status === 408 || status >= 500) {
    code = 'provider_unavailable';
    message = `${provider} is temporarily unavailable.`;
    action = 'Retry later and check the provider status page.';
    retryable = true;
  } else if (/timeout|timed out/i.test(`${error?.name || ''} ${error?.message || ''}`)) {
    code = 'provider_timeout';
    message = `${provider} request timed out.`;
    action = 'Reduce output tokens or increase the configured provider timeout.';
    retryable = true;
  } else if (/connection|network|fetch/i.test(`${error?.name || ''} ${error?.message || ''}`)) {
    code = 'provider_connection_failed';
    message = `${provider} could not be reached.`;
    action = 'Check outbound network access and the provider status page.';
    retryable = true;
  }

  return { provider, code, message, action, retryable, ...(status && { status }), ...(requestId && { requestId }) };
}
