// Everything about keeping a connection alive: handing out a working access token,
// refreshing it, and disconnecting. The rules come from Jetlog's guide:
//
//   * Refresh a minute before the access token expires, and when a call answers 401.
//   * One refresh at a time. A refresh token works once, so two refreshes would race
//     and the loser would be told invalid_grant.
//   * Store the new refresh token before using anything else from the response.
//   * invalid_grant on a refresh means the connection is over: delete the tokens.
//   * unauthorized_client on a refresh means the registration is switched off:
//     keep the tokens, they work again when it is switched back on.

import {
  DisconnectedError,
  JetlogApiError,
  NotConnectedError,
  RegistrationDisabledError,
} from './errors.js';
import { refreshGrant, revokeToken } from './token-endpoint.js';
import { tokensFromResponse } from './token-store.js';

const REFRESH_MARGIN_MS = 60_000;

export function createTokenManager({ config, store, now = Date.now }) {
  // The refresh that is running right now, if any. Everyone who needs a refresh
  // while it runs waits for this same promise.
  let refreshInFlight = null;

  function requireTokens() {
    const tokens = store.load();
    if (!tokens?.refreshToken) throw new NotConnectedError();
    return tokens;
  }

  // The access token to put in an Authorization header, refreshed first when it
  // is about to expire.
  async function getAccessToken() {
    const tokens = requireTokens();
    if (tokens.expiresAt - now() > REFRESH_MARGIN_MS) return tokens.accessToken;
    return refreshTokens(tokens.accessToken);
  }

  // `staleAccessToken` is the token the caller found expired or got a 401 for.
  // When the stored token is already a different one, somebody else refreshed in
  // the meantime and we must not spend the new refresh token a second time.
  function refreshTokens(staleAccessToken) {
    if (!refreshInFlight) {
      refreshInFlight = runRefresh(staleAccessToken).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function runRefresh(staleAccessToken) {
    const current = requireTokens();
    if (staleAccessToken && current.accessToken !== staleAccessToken) {
      return current.accessToken;
    }

    const result = await refreshGrant(config, current.refreshToken);

    if (result.status === 200 && result.body?.access_token && result.body?.refresh_token) {
      const next = tokensFromResponse(result.body, { now, previous: current });
      // The old refresh token is spent now. Write the new one down before anything
      // else can fail, otherwise a crash here would lock the pilot out.
      store.save(next);
      return next.accessToken;
    }

    const code = result.body?.error;
    if (result.status === 400 && code === 'invalid_grant') {
      store.clear();
      throw new DisconnectedError();
    }
    if (result.status === 400 && code === 'unauthorized_client') {
      throw new RegistrationDisabledError();
    }
    // Anything else (429, 5xx, an odd answer) leaves the tokens as they are.
    throw JetlogApiError.fromResult(result);
  }

  // Runs one request with a valid access token. On a 401 it refreshes once and
  // repeats the request once. A second 401 is handed back to the caller.
  // `makeRequest(accessToken)` must return the result of send().
  async function callWithToken(makeRequest) {
    const accessToken = await getAccessToken();
    const result = await makeRequest(accessToken);
    if (result.status !== 401) return result;

    const freshAccessToken = await refreshTokens(accessToken);
    return makeRequest(freshAccessToken);
  }

  // Revokes the refresh token at Jetlog and deletes what we stored. The local
  // tokens are deleted even when Jetlog cannot be reached, and the result says
  // whether the revoke went through.
  async function disconnect() {
    // A refresh that is running has just replaced the token we would revoke.
    if (refreshInFlight) await refreshInFlight.catch(() => {});

    const tokens = store.load();
    if (!tokens) return { revoked: false, reason: 'not_connected' };

    let outcome = { revoked: true };
    try {
      const result = await revokeToken(config, tokens.refreshToken);
      if (result.status !== 200) outcome = { revoked: false, reason: `status_${result.status}` };
    } catch {
      outcome = { revoked: false, reason: 'unreachable' };
    }
    store.clear();
    return outcome;
  }

  return { getAccessToken, refreshTokens, callWithToken, disconnect };
}
