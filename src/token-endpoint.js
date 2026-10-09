// The three calls to Jetlog's token endpoints. They only talk to Jetlog and return
// { status, ok, body, retryAfter }. What an answer means is decided by the callers.

import { formBody, send } from './http.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

// Step 5 of the flow. The code is valid for 60 seconds and works once.
export function exchangeCode(config, { code, codeVerifier, redirectUri }) {
  return send(
    `${config.baseUrl}/oauth/token`,
    {
      method: 'POST',
      headers: FORM,
      body: formBody({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        resource: config.partnerApiUrl,
      }),
    },
    { timeoutMs: 15_000 },
  );
}

// A refresh token works once. The answer carries the next one.
// The timeout is generous on purpose: when we cannot tell whether a refresh went
// through, the old token may already be spent.
export function refreshGrant(config, refreshToken) {
  return send(
    `${config.baseUrl}/oauth/token`,
    {
      method: 'POST',
      headers: FORM,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
      }),
    },
    { timeoutMs: 30_000 },
  );
}

// RFC 7009. Jetlog answers 200 with an empty body, whether or not the token was live.
export function revokeToken(config, refreshToken) {
  return send(
    `${config.baseUrl}/oauth/revoke`,
    {
      method: 'POST',
      headers: FORM,
      body: formBody({ token: refreshToken, token_type_hint: 'refresh_token' }),
    },
    { timeoutMs: 15_000 },
  );
}
