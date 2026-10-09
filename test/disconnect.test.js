import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JetlogApiError } from '../src/errors.js';
import { setup } from '../test-support/harness.js';

test('disconnecting revokes the refresh token and deletes the stored tokens', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  const { refreshToken, accessToken } = h.store.load();

  const outcome = await h.tokens.disconnect();

  assert.deepEqual(outcome, { revoked: true });
  assert.equal(h.store.load(), null);

  const [revoke] = h.fake.requestsTo('/oauth/revoke');
  assert.equal(revoke.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(revoke.body, { token: refreshToken, token_type_hint: 'refresh_token' });

  // Revoking the refresh token also ends the access token that came with it.
  const response = await fetch(`${h.config.partnerApiUrl}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(response.status, 401);
});

test('the stored tokens are deleted even when Jetlog does not confirm the revoke', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  h.fake.respondOnce('POST', '/oauth/revoke', { status: 429, headers: { 'Retry-After': '5' } });
  const outcome = await h.tokens.disconnect();

  assert.deepEqual(outcome, { revoked: false, reason: 'status_429' });
  assert.equal(h.store.load(), null);
});

test('the stored tokens are deleted even when Jetlog cannot be reached', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  await h.fake.close();

  const outcome = await h.tokens.disconnect();
  assert.deepEqual(outcome, { revoked: false, reason: 'unreachable' });
  assert.equal(h.store.load(), null);
});

test('disconnecting while a refresh runs revokes the newest refresh token', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  const { accessToken, refreshToken: oldRefreshToken } = h.store.load();
  h.fake.refreshDelayMs = 50;

  const refreshing = h.tokens.refreshTokens(accessToken);
  const disconnecting = h.tokens.disconnect();
  await Promise.all([refreshing, disconnecting]);

  const [revoke] = h.fake.requestsTo('/oauth/revoke');
  assert.notEqual(revoke.body.token, oldRefreshToken);
  assert.equal(h.fake.refreshTokens.get(revoke.body.token).revoked, true);
  assert.equal(h.store.load(), null);
});

test('disconnecting when nothing is connected sends nothing', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  assert.deepEqual(await h.tokens.disconnect(), { revoked: false, reason: 'not_connected' });
  assert.equal(h.fake.requestsTo('/oauth/revoke').length, 0);
});

test('after disconnecting, calls fail as not connected', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  await h.tokens.disconnect();

  await assert.rejects(h.api.getMe(), (err) => !(err instanceof JetlogApiError) && /Not connected/.test(err.message));
});
