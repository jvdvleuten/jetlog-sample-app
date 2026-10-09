// The whole sample through its web pages, talking to the fake Jetlog.

import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { makeEntry } from '../test-support/fake-jetlog.js';
import { setup } from '../test-support/harness.js';

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Starts the sample on a free port and returns small helpers that act like a browser:
// redirects are not followed, so the test can look at each step.
async function startSample(t) {
  const port = await freePort();
  const h = await setup({ port: String(port) });
  const app = createApp({ config: h.config, store: h.store, now: h.now });
  const server = createServer(app.handle);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await h.cleanup();
  });

  const base = `http://127.0.0.1:${port}`;
  const answer = async (response) => ({
    status: response.status,
    location: response.headers.get('location'),
    text: await response.text(),
  });

  return {
    ...h,
    app,
    base,
    get: async (path, headers = {}) => answer(await fetch(base + path, { redirect: 'manual', headers })),
    post: async (path, form = {}, headers = {}) =>
      answer(
        await fetch(base + path, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          body: new URLSearchParams(form).toString(),
        }),
      ),
    // Like a browser: follow one redirect to a page on the sample.
    async follow(response) {
      assert.equal(response.status, 303);
      return this.get(new URL(response.location, base).pathname + new URL(response.location, base).search);
    },
    // The pilot presses a connect button, approves in Jetlog, and lands on the callback.
    async connectThroughPages(access, { grant } = {}) {
      const start = await this.post('/connect', { access });
      assert.equal(start.status, 303);
      const callbackUrl = h.fake.approve(start.location, { scope: grant });
      const callback = await this.get(new URL(callbackUrl).pathname + new URL(callbackUrl).search);
      assert.equal(callback.status, 303);
      assert.equal(callback.location, '/');
      return callback;
    },
  };
}

test('the home page offers the two access levels before connecting', async (t) => {
  const s = await startSample(t);
  const page = await s.get('/');

  assert.equal(page.status, 200);
  assert.match(page.text, /Connect: Own flights only/);
  assert.match(page.text, /Connect: Whole logbook/);
  assert.doesNotMatch(page.text, /Add a flight/);
});

test('pressing a connect button sends the pilot to Jetlog with the matching scope', async (t) => {
  const s = await startSample(t);

  const own = await s.post('/connect', { access: 'own' });
  assert.equal(own.status, 303);
  assert.equal(new URL(own.location).searchParams.get('scope'), 'import');
  assert.equal(new URL(own.location).origin + new URL(own.location).pathname, `${s.fake.url}/oauth/authorize`);

  const full = await s.post('/connect', { access: 'full' });
  assert.equal(new URL(full.location).searchParams.get('scope'), 'import read write');

  assert.equal((await s.post('/connect', { access: 'root' })).status, 400);
});

test('the full path: connect, import, read, propose, check the status, disconnect', async (t) => {
  const s = await startSample(t);
  s.fake.entries = [makeEntry(1, '2026-10-01', { flight_number: 'KL1001', to: 'LEMD', derived: { date: '2026-10-01', from: 'EHAM', to: 'LEMD' } })];

  // Connect, and see what was granted.
  await s.connectThroughPages('full');
  let home = await s.get('/');
  assert.match(home.text, /Connected: Whole logbook/);
  assert.match(home.text, /Add a flight/);
  assert.match(home.text, /<a href="\/logbook">Logbook<\/a>/);

  // Import a flight.
  const imported = await s.post('/import', { date: '2026-10-08', flightNumber: 'kl1023', from: 'eham', to: 'egll' });
  assert.equal(imported.status, 303);
  assert.equal(imported.location, '/');
  assert.deepEqual(s.fake.requestsTo('/api/partner/v1/import')[0].body.entries[0], {
    type: 'flight',
    date: '2026-10-08',
    flight_number: 'KL1023',
    from: 'EHAM',
    to: 'EGLL',
  });
  home = await s.get('/');
  assert.match(home.text, /Jetlog accepted the flight/);
  // The message is shown once.
  assert.doesNotMatch((await s.get('/')).text, /Jetlog accepted the flight/);

  // Read.
  const logbook = await s.get('/logbook');
  assert.equal(logbook.status, 200);
  assert.match(logbook.text, /Anna de Vries/);
  assert.doesNotMatch(logbook.text, /@/);
  assert.match(logbook.text, /KL1001/);
  assert.match(logbook.text, /action="\/propose"/);

  // Propose, which writes nothing.
  const proposed = await s.post('/propose', { entryId: 'entry-001', label: '2026-10-01 KL1001 EHAM to LEMD', remarks: 'Late departure' });
  assert.equal(proposed.status, 303);
  assert.match(proposed.location, /^\/changes\/.+/);
  assert.equal(s.fake.entries[0].remarks, null);

  const status = await s.follow(proposed);
  assert.match(status.text, /Proposal sent. Nothing has changed yet./);
  assert.match(status.text, /Status: pending/);
  assert.match(status.text, /Nothing changes until the pilot approves it in the Jetlog app/);

  // What the proposal changes, from the preview.
  assert.match(status.text, /What it changes/);
  assert.match(status.text, /<code>remarks<\/code><\/td><td>\(empty\)<\/td><td>Late departure<\/td>/);
  assert.match(status.text, /<h3>Operations<\/h3>/);
  assert.doesNotMatch(status.text, /Not applied|>Applied</);

  // The pilot approves in the Jetlog app, and the status page reads it.
  const [id] = s.fake.changes.keys();
  s.fake.approveChange(id);
  const after = await s.get(proposed.location);
  assert.match(after.text, /Status: applied/);
  assert.match(after.text, />Applied</);
  assert.doesNotMatch(after.text, /Nothing changes until/);

  // Disconnect.
  const gone = await s.post('/disconnect');
  assert.equal(gone.status, 303);
  assert.equal(s.fake.requestsTo('/oauth/revoke').length, 1);
  home = await s.get('/');
  assert.match(home.text, /Disconnected/);
  assert.match(home.text, /Connect: Whole logbook/);
  assert.equal(s.store.load(), null);
});

test('when the pilot grants less than asked, the page says so and offers no reading', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('full', { grant: 'import' });

  const home = await s.get('/');
  assert.match(home.text, /Connected, with less access than asked for/);
  assert.match(home.text, /Connected: Own flights only/);
  assert.match(home.text, /<code>import read write<\/code>/);
  assert.doesNotMatch(home.text, /<a href="\/logbook">/);
  assert.match(home.text, /Add a flight/);
});

test('a declined connection says nothing was connected', async (t) => {
  const s = await startSample(t);
  const start = await s.post('/connect', { access: 'own' });
  const callbackUrl = s.fake.deny(start.location, 'access_denied');
  const callback = await s.get(new URL(callbackUrl).pathname + new URL(callbackUrl).search);

  assert.equal(callback.status, 303);
  const home = await s.follow(callback);
  assert.match(home.text, /The connection was not made/);
  assert.match(home.text, /Connect: Own flights only/);
});

test('a callback with a wrong state shows an error and connects nothing', async (t) => {
  const s = await startSample(t);
  await s.post('/connect', { access: 'own' });
  const callback = await s.get(`/callback?code=abc&state=wrong&iss=${encodeURIComponent(s.fake.url)}`);

  const home = await s.follow(callback);
  assert.match(home.text, /not started here/);
  assert.equal(s.store.load(), null);
  assert.equal(s.fake.requestsTo('/oauth/token').length, 0);
});

test('a refused import shows a visible error and keeps the connection', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('own');

  s.fake.respondOnce('POST', '/api/partner/v1/import', { status: 429, headers: { 'Retry-After': '30' }, body: { error: 'rate_limited', retry_after: 30 } });
  const imported = await s.post('/import', { date: '2026-10-08', flightNumber: 'KL1', from: 'EHAM', to: 'EGLL' });
  const home = await s.follow(imported);

  assert.match(home.text, /Too many requests/);
  assert.match(home.text, /wait 30 seconds/);
  assert.match(home.text, /Add a flight/);
});

test('a bad date is refused without calling Jetlog', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('own');

  const imported = await s.post('/import', { date: '14-08-2026', flightNumber: 'KL1', from: 'EHAM', to: 'EGLL' });
  const home = await s.follow(imported);
  assert.match(home.text, /date has to look like 2026-08-14/);
  assert.equal(s.fake.requestsTo('/api/partner/v1/import').length, 0);
});

test('when the connection has ended at Jetlog, the page says so and the tokens are gone', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('full');

  s.fake.refreshBehaviour = 'invalid_grant';
  s.fake.expireAccessTokens();
  const logbook = await s.get('/logbook');
  const home = await s.follow(logbook);

  assert.match(home.text, /The connection with Jetlog ended/);
  assert.match(home.text, /Connect: Whole logbook/);
  assert.equal(s.store.load(), null);
});

test('the refresh button refreshes and says the new refresh token was stored', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('own');
  const before = s.store.load();

  const refreshed = await s.post('/refresh');
  const home = await s.follow(refreshed);

  assert.match(home.text, /The tokens were refreshed/);
  assert.equal(s.fake.refreshCalls, 1);
  assert.notEqual(s.store.load().refreshToken, before.refreshToken);
});

test('text that comes from Jetlog is escaped on the page', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('own');

  s.fake.importResponse = {
    data: 'OK',
    skipped: [{ date: '2026-10-08', flight_number: '<script>alert(1)</script>', reason: 'duplicate', from: 'EHAM', to: 'EGLL' }],
  };
  const imported = await s.post('/import', { date: '2026-10-08', flightNumber: 'KL1', from: 'EHAM', to: 'EGLL' });
  const home = await s.follow(imported);

  assert.doesNotMatch(home.text, /<script>alert/);
  assert.match(home.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a page on another site cannot press a button', async (t) => {
  const s = await startSample(t);
  await s.connectThroughPages('own');

  const foreign = await s.post('/disconnect', {}, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.ok(s.store.load(), 'the tokens are still there');
  assert.equal(s.fake.requestsTo('/oauth/revoke').length, 0);
});

test('a request with another Host header is refused', async (t) => {
  const s = await startSample(t);
  const port = new URL(s.base).port;

  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('unknown addresses are a 404', async (t) => {
  const s = await startSample(t);
  assert.equal((await s.get('/nothing-here')).status, 404);
});

test('when Jetlog cannot be reached during the code exchange, the page says so', async (t) => {
  const s = await startSample(t);
  const start = await s.post('/connect', { access: 'own' });
  const callbackUrl = s.fake.approve(start.location);
  await s.fake.close();

  const callback = await s.get(new URL(callbackUrl).pathname + new URL(callbackUrl).search);
  const home = await s.follow(callback);
  assert.match(home.text, /Jetlog could not be reached/);
  assert.equal(s.store.load(), null);
});

test('after a partial approval the status page says which operations were applied', async (t) => {
  const s = await startSample(t);
  s.fake.entries = [makeEntry(1, '2026-10-01'), makeEntry(2, '2026-10-02')];
  await s.connectThroughPages('full');

  const change = await s.api.proposeChanges({
    summary: 'Two remarks',
    operations: [
      { op: 'update', resource: 'entry', id: 'entry-001', data: { remarks: 'one' } },
      { op: 'update', resource: 'entry', id: 'entry-002', data: { remarks: 'two' } },
    ],
  });
  s.fake.approveChange(change.id, { operationIndices: [0] });

  const page = await s.get(`/changes/${change.id}`);
  assert.match(page.text, /Status: applied/);
  assert.match(page.text, /can approve only some of the operations/);
  const rows = page.text.match(/<td>(Applied|Not applied)<\/td>/g);
  assert.deepEqual(rows, ['<td>Applied</td>', '<td>Not applied</td>']);
});

test('the status page explains stale, failed and revoked', async (t) => {
  const s = await startSample(t);
  s.fake.entries = [makeEntry(1, '2026-10-01')];
  await s.connectThroughPages('full');
  const proposal = { summary: 'x', operations: [{ op: 'update', resource: 'entry', id: 'entry-001', data: { remarks: 'one' } }] };

  const stale = await s.api.proposeChanges(proposal);
  s.fake.setChangeStatus(stale.id, 'stale');
  assert.match((await s.get(`/changes/${stale.id}`)).text, /changed after the proposal was made/);

  const failed = await s.api.proposeChanges(proposal);
  s.fake.setChangeStatus(failed.id, 'failed', { error: 'entry was removed' });
  const failedPage = (await s.get(`/changes/${failed.id}`)).text;
  assert.match(failedPage, /Applying the proposal failed/);
  assert.match(failedPage, /Error from Jetlog: entry was removed/);

  const revoked = await s.api.proposeChanges(proposal);
  s.fake.setChangeStatus(revoked.id, 'revoked');
  assert.match((await s.get(`/changes/${revoked.id}`)).text, /pilot disconnected this app/);
});

test('when Jetlog has not enabled the whole logbook, the quiet downgrade is explained with both reasons', async (t) => {
  const s = await startSample(t);
  s.fake.wholeLogbookEnabled = false;
  // The pilot does not choose anything here: Jetlog narrows the request by itself.
  await s.connectThroughPages('full');

  assert.equal(s.store.load().scope, 'import');
  const home = await s.get('/');
  assert.match(home.text, /Connected, with less access than asked for/);
  assert.match(home.text, /chose the lower level in the Jetlog app/);
  assert.match(home.text, /has not enabled the whole logbook for this app, in which case Jetlog quietly grants own flights only and reports no error/);
  assert.doesNotMatch(home.text, /<a href="\/logbook">/);
});

test('a proposal that changes nothing shows no change table', async (t) => {
  const s = await startSample(t);
  s.fake.entries = [makeEntry(1, '2026-10-01')];
  await s.connectThroughPages('full');

  const change = await s.api.proposeChanges({
    summary: 'x',
    operations: [{ op: 'update', resource: 'entry', id: 'entry-001', data: { remarks: 'one' } }],
  });
  s.fake.changes.get(change.id).preview[0].changed_fields = [];

  const page = await s.get(`/changes/${change.id}`);
  assert.doesNotMatch(page.text, /What it changes/);
  assert.match(page.text, /<h3>Operations<\/h3>/);
});
