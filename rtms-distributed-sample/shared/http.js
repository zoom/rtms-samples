import fetch from 'node-fetch';
import { HttpError } from './errors.js';
import { buildInternalSignatureHeaders } from './internalSignature.js';
import { retryWithBackoff } from './retry.js';

export async function postJson(url, body, options = {}) {
  return requestJson(url, {
    method: 'POST',
    body,
    timeoutMs: options.timeoutMs,
    headers: options.headers,
    signingSecret: options.signingSecret,
    retry: options.retry,
    retryPolicy: options.retryPolicy,
    label: options.label || `POST ${url}`
  });
}

export async function putJson(url, body, options = {}) {
  return requestJson(url, {
    method: 'PUT',
    body,
    timeoutMs: options.timeoutMs,
    headers: options.headers,
    signingSecret: options.signingSecret,
    retry: options.retry,
    retryPolicy: options.retryPolicy,
    label: options.label || `PUT ${url}`
  });
}

export async function getJson(url, options = {}) {
  return requestJson(url, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    headers: options.headers,
    retry: options.retry,
    retryPolicy: options.retryPolicy,
    label: options.label || `GET ${url}`
  });
}

export function fireAndForget(promise, label = 'background task') {
  promise.catch((error) => {
    console.error(`[${label}] ${error.message}`);
  });
}

async function requestJson(url, options = {}) {
  const retryEnabled = options.retry !== false;
  if (!retryEnabled) {
    return requestJsonOnce(url, options);
  }

  return retryWithBackoff(() => requestJsonOnce(url, options), {
    maxAttempts: options.retryPolicy?.maxAttempts || 3,
    baseDelayMs: options.retryPolicy?.baseDelayMs || 200,
    maxDelayMs: options.retryPolicy?.maxDelayMs || 2000,
    label: options.label
  });
}

async function requestJsonOnce(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  const bodyText = options.body == null ? undefined : JSON.stringify(options.body);
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {})
  };

  if (options.signingSecret) {
    Object.assign(headers, buildInternalSignatureHeaders(bodyText || '', options.signingSecret));
  }

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: bodyText,
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`${options.method || 'GET'} ${url} failed`, {
        method: options.method || 'GET',
        url,
        status: response.status,
        body: text
      });
    }
    const data = parseResponseBody(text, response.headers.get('content-type'), url);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function parseResponseBody(text, contentType = '', url) {
  if (!text) return null;
  if (!String(contentType).toLowerCase().includes('application/json')) {
    return text;
  }
  return parseJsonResponse(text, url);
}

function parseJsonResponse(text, url) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(`Invalid JSON response from ${url}`, {
      url,
      status: 502,
      body: text
    });
  }
}
