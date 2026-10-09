import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCallback, startConnect } from '../src/connect.js';
import { createCodeChallenge } from '../src/pkce.js';
import { describeGrant } from '../src/plain-words.js';
import { setup } from '../test-support/harness.js';

const queryOf = (callbackUrl) => Object.fromEntries(new URL(callbackUrl).searchParams);

async function callback(h, query) {
  return handleCallback({ query, config: h.config, pending: h.pending, store: h.store, now: h.now });
}

// ---- the authorize URL ----

test('the authorize URL carries everything Jetlog needs, for own flights only', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = new URL(startConnect({ access: 'own', config: h.config, pending: h.pending }));
  assert.equal(`${url.origin}${url.pathname}`, `${h.fake.url}/oauth/authorize`);

  const query = url.searchParams;
  assert.equal(query.get('response_type'), 'code');
  assert.equal(query.get('client_id'), 'https://app.example/client.json');
  assert.equal(query.get('redirect_uri'), 'http://127.0.0.1:8787/callback');
  assert.equal(query.get('scope'), 'import');
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.equal(query.get('resource'), `${h.fake.url}/api/partner/v1`);
  assert.ok(query.get('state'));
  assert.ok(query.get('code_challenge'));
});

test('asking for the whole logbook asks for import, read and write', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'full', config: h.config, pending: h.pending });
  assert.equal(new URL(url).searchParams.get('scope'), 'import read write');
  // Spaces are written as %20, the way the Jetlog guide shows them.
  assert.match(url, /scope=import%20read%20write&/);
});

test('the challenge in the URL belongs to the verifier the sample keeps', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = new URL(startConnect({ access: 'full', config: h.config, pending: h.pending }));
  const attempt = h.pending.take(url.searchParams.get('state'));
  assert.equal(createCodeChallenge(attempt.codeVerifier), url.searchParams.get('code_challenge'));
  assert.equal(attempt.redirectUri, 'http://127.0.0.1:8787/callback');
  assert.equal(attempt.requestedScope, 'import read write');
});

test('every attempt has its own state, and an unknown level is refused', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const first = new URL(startConnect({ access: 'own', config: h.config, pending: h.pending }));
  const second = new URL(startConnect({ access: 'own', config: h.config, pending: h.pending }));
  assert.notEqual(first.searchParams.get('state'), second.searchParams.get('state'));
  assert.notEqual(first.searchParams.get('code_challenge'), second.searchParams.get('code_challenge'));
  assert.throws(() => startConnect({ access: 'everything', config: h.config, pending: h.pending }));
});

// ---- the callback ----

test('a good callback exchanges the code and stores the tokens', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const outcome = await h.connect('full');
  assert.equal(outcome.ok, true);

  // What the sample sent to the token endpoint.
  const [exchange] = h.fake.requestsTo('/oauth/token');
  assert.equal(exchange.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.keys(exchange.body).sort(), [
    'client_id',
    'code',
    'code_verifier',
    'grant_type',
    'redirect_uri',
    'resource',
  ]);
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.body.resource, `${h.fake.url}/api/partner/v1`);

  const stored = h.store.load();
  assert.match(stored.accessToken, /^jlp_/);
  assert.match(stored.refreshToken, /^jlr_/);
  assert.equal(stored.scope, 'import read write');
  assert.equal(stored.requestedScope, 'import read write');
  assert.equal(stored.expiresAt, h.now() + 3600 * 1000);
});

test('a callback with the wrong state is refused before anything is sent to Jetlog', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const query = queryOf(h.fake.approve(url));

  const outcome = await callback(h, { ...query, state: 'not-the-state' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'state_mismatch');
  assert.equal(h.fake.requestsTo('/oauth/token').length, 0);
  assert.equal(h.store.load(), null);
});

test('a callback without state is refused', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  startConnect({ access: 'own', config: h.config, pending: h.pending });
  const outcome = await callback(h, { code: 'abc', iss: h.fake.url });
  assert.equal(outcome.code, 'state_mismatch');
  assert.equal(h.fake.requestsTo('/oauth/token').length, 0);
});

test('a callback from another issuer is refused', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const query = queryOf(h.fake.approve(url));

  const outcome = await callback(h, { ...query, iss: 'https://evil.example' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'issuer_mismatch');
  assert.equal(h.fake.requestsTo('/oauth/token').length, 0);
  assert.equal(h.store.load(), null);
});

test('a callback without iss is refused', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const { iss, ...withoutIss } = queryOf(h.fake.approve(url));
  const outcome = await callback(h, withoutIss);
  assert.equal(outcome.code, 'issuer_mismatch');
});

test('the same callback cannot be used twice', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const query = queryOf(h.fake.approve(url));

  assert.equal((await callback(h, query)).ok, true);
  const replay = await callback(h, query);
  assert.equal(replay.code, 'state_mismatch');
  assert.equal(h.fake.requestsTo('/oauth/token').length, 1);
});

test('an attempt that is too old is forgotten', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const query = queryOf(h.fake.approve(url));
  h.advance(16 * 60 * 1000);
  assert.equal((await callback(h, query)).code, 'state_mismatch');
});

test('error=access_denied says nothing was connected and sends nothing to Jetlog', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'full', config: h.config, pending: h.pending });
  const outcome = await callback(h, queryOf(h.fake.deny(url, 'access_denied')));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'access_denied');
  assert.match(outcome.title, /not made/);
  assert.equal(h.fake.requestsTo('/oauth/token').length, 0);
  assert.equal(h.store.load(), null);
});

test('error=unauthorized_client explains that the app is not registered', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'full', config: h.config, pending: h.pending });
  const outcome = await callback(h, queryOf(h.fake.deny(url, 'unauthorized_client', 'not registered')));

  assert.equal(outcome.code, 'unauthorized_client');
  assert.ok(outcome.lines.join(' ').includes('https://app.example/client.json'));
  assert.ok(outcome.lines.join(' ').includes('https://jetlog.app/developers'));
  assert.ok(outcome.lines.join(' ').includes('support@jetlog.app'));
  assert.equal(h.store.load(), null);
});

test('any other error is shown with its description', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'full', config: h.config, pending: h.pending });
  const outcome = await callback(h, queryOf(h.fake.deny(url, 'invalid_request', 'resource is wrong')));

  assert.equal(outcome.code, 'authorization_error');
  assert.match(outcome.title, /invalid_request/);
  assert.deepEqual(outcome.lines, ['resource is wrong']);
});

test('an error parameter is only believed when the state is right', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'full', config: h.config, pending: h.pending });
  const query = queryOf(h.fake.deny(url, 'access_denied'));

  assert.equal((await callback(h, { ...query, state: 'guess' })).code, 'state_mismatch');
  assert.equal(h.store.load(), null);
});

test('an error parameter from another issuer is not believed either', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'full', config: h.config, pending: h.pending });
  const query = queryOf(h.fake.deny(url, 'access_denied'));
  assert.equal((await callback(h, { ...query, iss: 'https://evil.example' })).code, 'issuer_mismatch');
});

test('a callback with neither code nor error is refused', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const { code, ...withoutCode } = queryOf(h.fake.approve(url));
  assert.equal((await callback(h, withoutCode)).code, 'missing_code');
});

test('when Jetlog refuses the code, nothing is stored', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  h.fake.respondOnce('POST', '/oauth/token', { status: 400, body: { error: 'invalid_grant' } });
  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const outcome = await callback(h, queryOf(h.fake.approve(url)));

  assert.equal(outcome.code, 'invalid_grant');
  assert.match(outcome.lines.join(' '), /60 seconds/);
  assert.equal(h.store.load(), null);
});

test('a rate limit on the code exchange says how long to wait', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  h.fake.respondOnce('POST', '/oauth/token', {
    status: 429,
    headers: { 'Retry-After': '12' },
    body: { error: 'rate_limited', retry_after: 12 },
  });
  const url = startConnect({ access: 'own', config: h.config, pending: h.pending });
  const outcome = await callback(h, queryOf(h.fake.approve(url)));

  assert.equal(outcome.code, 'rate_limited');
  assert.match(outcome.lines.join(' '), /12 seconds/);
});

// ---- what was granted ----

test('asked for the whole logbook, granted own flights only: the grant is the smaller one', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const outcome = await h.connect('full', { grant: 'import' });
  assert.equal(outcome.tokens.scope, 'import');
  assert.equal(outcome.tokens.requestedScope, 'import read write');

  const grant = describeGrant({ requested: outcome.tokens.requestedScope, granted: outcome.tokens.scope });
  assert.equal(grant.downgraded, true);
  assert.equal(grant.grantedLevel, 'own');
  assert.deepEqual(grant.abilities, { import: true, read: false, propose: false });
  assert.match(grant.downgradeNote, /asked for the whole logbook and got less/);
});

test('whole logbook granted as asked is not a downgrade', async (t) => {
  const h = await setup();
  t.after(h.cleanup);

  const outcome = await h.connect('full');
  const grant = describeGrant({ requested: outcome.tokens.requestedScope, granted: outcome.tokens.scope });
  assert.equal(grant.downgraded, false);
  assert.equal(grant.grantedLevel, 'full');
  assert.deepEqual(grant.abilities, { import: true, read: true, propose: true });
  assert.equal(grant.downgradeNote, null);
});

test('own flights asked and granted is plain own flights', () => {
  const grant = describeGrant({ requested: 'import', granted: 'import' });
  assert.equal(grant.downgraded, false);
  assert.equal(grant.headline, 'Own flights only');
  assert.match(grant.summary, /cannot read your logbook/);
});

test('when Jetlog has not enabled the whole logbook for the app, the request is narrowed without an error', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  h.fake.wholeLogbookEnabled = false;

  // The sample asks for everything, Jetlog answers scope "import", and that is no failure.
  const outcome = await h.connect('full');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.tokens.requestedScope, 'import read write');
  assert.equal(outcome.tokens.scope, 'import');

  const grant = describeGrant({ requested: outcome.tokens.requestedScope, granted: outcome.tokens.scope });
  assert.equal(grant.downgraded, true);
  assert.match(grant.downgradeNote, /chose the lower level/);
  assert.match(grant.downgradeNote, /has not enabled the whole logbook for this app, in which case Jetlog quietly grants own flights only and reports no error/);
  assert.match(grant.downgradeNote, /asking again gives the same result/);
});
