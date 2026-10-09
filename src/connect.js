// Steps 1 and 2 of the flow: send the pilot to Jetlog, and handle the way back.

import { createCodeChallenge, createCodeVerifier, createState } from './pkce.js';
import { exchangeCode } from './token-endpoint.js';
import { tokensFromResponse } from './token-store.js';

// What this app can ask for. The pilot has the last word in the Jetlog app and can
// always pick the lower level, so the scope in the token response may be smaller.
export const ACCESS_LEVELS = {
  own: { scope: 'import', label: 'Own flights only' },
  full: { scope: 'import read write', label: 'Whole logbook' },
};

// What we remember between sending the pilot away and the pilot coming back.
// It lives in memory and is keyed on `state`. A server with many pilots stores
// this per pilot session. Attempts older than ttlMs are forgotten (the sign-in
// page itself is valid for ten minutes).
export function createPendingAuthorizations({ now = Date.now, ttlMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();

  return {
    add(state, attempt) {
      for (const [key, value] of attempts) {
        if (now() - value.createdAt > ttlMs) attempts.delete(key);
      }
      attempts.set(state, { ...attempt, createdAt: now() });
    },
    // An attempt can be used once. Taking it removes it.
    take(state) {
      const attempt = attempts.get(state);
      attempts.delete(state);
      if (!attempt || now() - attempt.createdAt > ttlMs) return null;
      return attempt;
    },
    get size() {
      return attempts.size;
    },
  };
}

// 1. Connect. Returns the address to send the pilot to.
export function startConnect({ access, config, pending }) {
  const level = ACCESS_LEVELS[access];
  if (!level) throw new Error(`Unknown access level "${access}"`);

  const state = createState();
  const codeVerifier = createCodeVerifier();

  pending.add(state, {
    codeVerifier,
    redirectUri: config.redirectUri,
    requestedScope: level.scope,
  });

  return buildAuthorizeUrl({
    config,
    scope: level.scope,
    state,
    codeChallenge: createCodeChallenge(codeVerifier),
  });
}

export function buildAuthorizeUrl({ config, scope, state, codeChallenge }) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: config.partnerApiUrl,
  });
  // URLSearchParams writes a space as "+". Both are valid, but "%20" is what the
  // guide shows, so use that.
  return `${config.baseUrl}/oauth/authorize?${query.toString().replace(/\+/g, '%20')}`;
}

// 2. Callback. `query` holds the parameters Jetlog put on the redirect.
// Returns { ok: true, tokens } after storing the tokens, or { ok: false, code,
// title, lines } with something to show the pilot.
export async function handleCallback({ query, config, pending, store, now = Date.now }) {
  // Check `state` first, and only trust anything else on the request after that.
  const attempt = query.state ? pending.take(query.state) : null;
  if (!attempt) {
    return failure('state_mismatch', 'This sign-in was not started here', [
      'The state value on the callback does not match an attempt this app started, or the attempt is too old. Nothing was connected.',
      'Start again from the home page.',
    ]);
  }

  // `iss` names the server that sent the pilot back. Anything else is not Jetlog.
  if (query.iss !== config.baseUrl) {
    return failure('issuer_mismatch', 'The answer did not come from Jetlog', [
      `Expected the issuer ${config.baseUrl}, got ${query.iss ?? 'nothing'}. Nothing was connected.`,
    ]);
  }

  if (query.error) return explainAuthorizationError(query, config);

  if (!query.code) {
    return failure('missing_code', 'Jetlog sent no code', ['The callback has neither a code nor an error.']);
  }

  const result = await exchangeCode(config, {
    code: query.code,
    codeVerifier: attempt.codeVerifier,
    redirectUri: attempt.redirectUri,
  });

  if (result.status === 400 && result.body?.error === 'invalid_grant') {
    return failure('invalid_grant', 'Jetlog did not accept the code', [
      'The code is only valid for 60 seconds, works once, and has to match the redirect address and the PKCE verifier.',
      'Start again from the home page.',
    ]);
  }
  if (result.status === 429) {
    return failure('rate_limited', 'Too many requests', [
      result.retryAfter === null ? 'Wait a little and start again.' : `Jetlog asked to wait ${result.retryAfter} seconds. Then start again.`,
    ]);
  }
  if (!result.ok || !result.body?.access_token || !result.body?.refresh_token) {
    return failure('token_error', 'Jetlog did not hand out tokens', [
      `Jetlog answered ${result.status}${result.body?.error ? ` (${result.body.error})` : ''}.`,
    ]);
  }

  // `scope` in the answer is what was granted. It can be less than we asked for.
  const tokens = tokensFromResponse(result.body, { now, requestedScope: attempt.requestedScope });
  store.save(tokens);
  return { ok: true, tokens };
}

// The redirect carries error= when the pilot declined, or when Jetlog refused the request.
function explainAuthorizationError(query, config) {
  if (query.error === 'access_denied') {
    return failure('access_denied', 'The connection was not made', [
      'The pilot declined or cancelled in Jetlog. Nothing is connected.',
      'Do not start the flow again on your own. Offer the connect button and let the pilot decide.',
    ]);
  }
  if (query.error === 'unauthorized_client') {
    return failure('unauthorized_client', 'Jetlog does not know this app', [
      `The client ID ${config.clientId} is not registered with Jetlog, or its registration is switched off.`,
      'Register your own app in the developer console at https://jetlog.app/developers. Until Jetlog has approved it, this is the answer you get. Write to support@jetlog.app when something looks wrong.',
    ]);
  }
  return failure('authorization_error', `Jetlog answered ${query.error}`, [
    query.error_description || 'Jetlog gave no description.',
  ]);
}

function failure(code, title, lines) {
  return { ok: false, code, title, lines };
}
