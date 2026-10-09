// One small wrapper around fetch, so every call to Jetlog gets a timeout and an
// answer in the same shape: { status, ok, body, retryAfter }.

import { NetworkError } from './errors.js';

export async function send(url, init = {}, { timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new NetworkError(String(url), cause);
  }

  const text = await response.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON. The status code still tells the story.
  }

  return {
    status: response.status,
    ok: response.ok,
    body,
    retryAfter: parseRetryAfter(response.headers.get('retry-after'), body),
  };
}

// Jetlog sends Retry-After in whole seconds, and repeats it in the body as retry_after.
function parseRetryAfter(header, body) {
  const fromHeader = Number.parseInt(header ?? '', 10);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
  const fromBody = Number(body?.retry_after);
  return Number.isFinite(fromBody) && fromBody >= 0 ? fromBody : null;
}

export function formBody(fields) {
  return new URLSearchParams(fields).toString();
}
