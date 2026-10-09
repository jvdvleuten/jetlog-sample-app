import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { test } from 'node:test';
import {
  DisconnectedError,
  explainError,
  JetlogApiError,
  NetworkError,
  NotConnectedError,
  RegistrationDisabledError,
} from '../src/errors.js';
import { createTokenManager } from '../src/token-manager.js';
import { setup } from '../test-support/harness.js';

const ONE_HOUR = 3600 * 1000;

// ---- when to refresh ----

test('a fresh access token is used as it is', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();

  const stored = h.store.load();
  h.advance(ONE_HOUR - 120 * 1000);
  assert.equal(await h.tokens.getAccessToken(), stored.accessToken);
  assert.equal(h.fake.refreshCalls, 0);
});

test('a token that is about to expire is refreshed first', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const before = h.store.load();

  h.advance(ONE_HOUR - 30 * 1000);
  const token = await h.tokens.getAccessToken();

  assert.equal(h.fake.refreshCalls, 1);
  assert.notEqual(token, before.accessToken);

  const [refresh] = h.fake.requestsTo('/oauth/token').slice(-1);
  assert.equal(refresh.body.grant_type, 'refresh_token');
  assert.equal(refresh.body.refresh_token, before.refreshToken);
  assert.equal(refresh.body.client_id, 'https://app.example/client.json');

  const after = h.store.load();
  assert.equal(after.accessToken, token);
  assert.notEqual(after.refreshToken, before.refreshToken);
  assert.equal(after.expiresAt, h.now() + ONE_HOUR);
  assert.equal(after.scope, 'import read write');
  assert.equal(after.requestedScope, before.requestedScope);
  assert.equal(after.connectedAt, before.connectedAt);
});

test('without a connection there is no token to hand out', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await assert.rejects(h.tokens.getAccessToken(), NotConnectedError);
});

// ---- one refresh at a time ----

test('two calls that need a refresh at the same moment cause one refresh', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  h.fake.refreshDelayMs = 50;
  h.advance(ONE_HOUR);

  const [first, second] = await Promise.all([h.tokens.getAccessToken(), h.tokens.getAccessToken()]);

  assert.equal(h.fake.refreshCalls, 1);
  assert.equal(first, second);
  assert.equal(h.store.load().accessToken, first);
});

test('five parallel requests with an expired token cause one refresh and all succeed', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  h.fake.refreshDelayMs = 50;
  h.advance(ONE_HOUR);

  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => h.api.getMe()));

  assert.equal(h.fake.refreshCalls, 1);
  assert.ok(answers.every((me) => me.email === 'pilot@example.com'));
});

test('a token that somebody else already replaced is not refreshed a second time', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const old = h.store.load().accessToken;

  const first = await h.tokens.refreshTokens(old);
  const second = await h.tokens.refreshTokens(old);

  assert.equal(h.fake.refreshCalls, 1);
  assert.equal(second, first);
});

// ---- a 401 ----

test('a 401 causes one refresh and one retry, and the retry succeeds', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const before = h.store.load();

  h.fake.expireAccessTokens();
  const me = await h.api.getMe();

  assert.equal(me.email, 'pilot@example.com');
  assert.equal(h.fake.refreshCalls, 1);

  const calls = h.fake.requestsTo('/api/partner/v1/me');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, `Bearer ${before.accessToken}`);
  assert.equal(calls[1].headers.authorization, `Bearer ${h.store.load().accessToken}`);
  assert.notEqual(calls[1].headers.authorization, calls[0].headers.authorization);
});

test('parallel requests that all get a 401 cause one refresh', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  h.fake.refreshDelayMs = 50;

  h.fake.expireAccessTokens();
  const answers = await Promise.all([h.api.getMe(), h.api.getMe(), h.api.getMe()]);

  assert.equal(h.fake.refreshCalls, 1);
  assert.equal(answers.length, 3);
});

test('a second 401 after the refresh is reported and not retried again', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();

  const unauthorized = { status: 401, body: { error: 'invalid_token' } };
  h.fake.respondOnce('GET', '/api/partner/v1/me', unauthorized);
  h.fake.respondOnce('GET', '/api/partner/v1/me', unauthorized);

  await assert.rejects(h.api.getMe(), (err) => {
    assert.ok(err instanceof JetlogApiError);
    assert.equal(err.status, 401);
    assert.equal(explainError(err).title, 'Jetlog does not accept the access token');
    return true;
  });
  assert.equal(h.fake.refreshCalls, 1);
  assert.equal(h.fake.requestsTo('/api/partner/v1/me').length, 2);
});

// ---- storing the new refresh token ----

test('the new refresh token is stored before the new access token is used', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();

  const events = [];
  const store = {
    ...h.store,
    save(tokens) {
      events.push('saved');
      h.store.save(tokens);
    },
  };
  const tokens = createTokenManager({ config: h.config, store, now: h.now });
  h.fake.onApiRequest = (request) => {
    // At the moment the fake sees the call, the file already holds the new refresh token.
    events.push(`api call with ${request.headers.authorization === `Bearer ${h.store.load().accessToken}` ? 'stored' : 'other'} token`);
  };

  h.advance(ONE_HOUR);
  const token = await tokens.getAccessToken();
  await fetch(`${h.config.partnerApiUrl}/me`, { headers: { Authorization: `Bearer ${token}` } });

  assert.deepEqual(events, ['saved', 'api call with stored token']);
});

test('when the new tokens cannot be stored, the failure is reported and no token is handed out', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();

  const store = {
    ...h.store,
    save() {
      throw new Error('disk full');
    },
  };
  const tokens = createTokenManager({ config: h.config, store, now: h.now });
  h.advance(ONE_HOUR);
  await assert.rejects(tokens.getAccessToken(), /disk full/);
});

test('the token file is private to the user', async (t) => {
  if (process.platform === 'win32') return t.skip('file modes do not apply on Windows');
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  assert.equal(statSync(h.file).mode & 0o777, 0o600);
});

// ---- when a refresh fails ----

test('invalid_grant on a refresh means disconnected, and the tokens are deleted', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();

  h.fake.refreshBehaviour = 'invalid_grant';
  h.fake.expireAccessTokens();

  await assert.rejects(h.api.getMe(), (err) => {
    assert.ok(err instanceof DisconnectedError);
    assert.match(explainError(err).lines.join(' '), /Connect again/);
    return true;
  });
  assert.equal(h.store.load(), null);
});

test('unauthorized_client on a refresh keeps the tokens and says the registration is off', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const before = h.store.load();

  h.fake.refreshBehaviour = 'unauthorized_client';
  h.advance(ONE_HOUR);

  await assert.rejects(h.api.getMe(), (err) => {
    assert.ok(err instanceof RegistrationDisabledError);
    assert.match(explainError(err).lines.join(' '), /kept/);
    return true;
  });
  assert.deepEqual(h.store.load(), before);
});

test('a rate limit on a refresh keeps the tokens and reports Retry-After', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const before = h.store.load();

  h.fake.refreshBehaviour = 'rate_limited';
  h.advance(ONE_HOUR);

  await assert.rejects(h.tokens.getAccessToken(), (err) => {
    assert.ok(err instanceof JetlogApiError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, 7);
    assert.match(explainError(err).lines.join(' '), /wait 7 seconds/);
    return true;
  });
  assert.deepEqual(h.store.load(), before);
});

test('a server error on a refresh keeps the tokens', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const before = h.store.load();

  h.fake.refreshBehaviour = 'server_error';
  h.advance(ONE_HOUR);

  await assert.rejects(h.tokens.getAccessToken(), (err) => err instanceof JetlogApiError && err.status === 500);
  assert.deepEqual(h.store.load(), before);
});

test('when Jetlog cannot be reached during a refresh, the tokens are kept', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();
  const before = h.store.load();

  h.advance(ONE_HOUR);
  await h.fake.close();

  await assert.rejects(h.tokens.getAccessToken(), NetworkError);
  assert.deepEqual(h.store.load(), before);
});

test('after a failed refresh the next call tries again', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect();

  h.fake.refreshBehaviour = 'rate_limited';
  h.advance(ONE_HOUR);
  await assert.rejects(h.tokens.getAccessToken());

  h.fake.refreshBehaviour = 'ok';
  assert.match(await h.tokens.getAccessToken(), /^jlp_/);
  assert.equal(h.fake.refreshCalls, 2);
});
