import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainError, JetlogApiError } from '../src/errors.js';
import { buildImportPayload, buildRemarksProposal } from '../src/jetlog-api.js';
import { describeChangeStatus, describeSkip, describeWarning } from '../src/plain-words.js';
import { importResultFlash } from '../src/views.js';
import { setup } from '../test-support/harness.js';

const flight = { date: '2026-08-14', flightNumber: 'kl1023', from: 'eham', to: 'egll' };

const entry = (n, date) => ({
  id: `entry-${String(n).padStart(3, '0')}`,
  type: 'flight',
  date,
  flight_number: `KL${n}`,
  from: 'EHAM',
  to: 'EGLL',
  remarks: null,
  derived: { date, from: 'EHAM', to: 'EGLL' },
});

// ---- import ----

test('the import payload is the documented one', () => {
  assert.deepEqual(buildImportPayload(flight), {
    entries: [{ type: 'flight', date: '2026-08-14', flight_number: 'KL1023', from: 'EHAM', to: 'EGLL' }],
    people: [],
  });
});

test('an empty flight number is left out', () => {
  const { entries } = buildImportPayload({ ...flight, flightNumber: '  ' });
  assert.equal('flight_number' in entries[0], false);
});

test('an import sends the payload with the access token and returns skipped and warnings', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const { tokens } = await h.connect('own');

  const result = await h.api.importFlights(buildImportPayload(flight));

  assert.equal(result.data, 'OK');
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.warnings, []);

  const [request] = h.fake.requestsTo('/api/partner/v1/import');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, `Bearer ${tokens.accessToken}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, buildImportPayload(flight));
});

test('skipped rows and warnings are shown in plain words, not hidden behind a 200', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  h.fake.importResponse = {
    data: 'OK',
    skipped: [
      { date: '2026-08-14', flight_number: 'KL1023', from: 'EHAM', to: 'EGLL', reason: 'duplicate' },
      { date: '2026-08-18', flight_number: 'KL1801', reason: 'invalid_field', fields: ['off_blocks'] },
    ],
    warnings: [{ date: '2026-08-19', flight_number: 'KL1901', ref_id: 'GHOST', reason: 'unresolved_person_ref' }],
  };
  const result = await h.api.importFlights(buildImportPayload(flight));
  const flash = importResultFlash(result);

  assert.equal(flash.kind, 'warn');
  assert.equal(flash.items.length, 3);
  assert.match(flash.items[0], /KL1023.*already exists from another source/);
  assert.match(flash.items[1], /not valid.*off_blocks/);
  assert.match(flash.items[2], /"GHOST".*left off/);
});

test('an import with nothing skipped says so', () => {
  assert.equal(importResultFlash({ skipped: [], warnings: [] }).kind, 'ok');
});

test('every skip reason from the guide has its own sentence', () => {
  for (const reason of ['duplicate', 'missing_route', 'unsupported_type', 'duplicate_in_payload', 'deleted', 'invalid_field']) {
    assert.doesNotMatch(describeSkip({ date: '2026-08-14', flight_number: 'KL1', reason }), /Left out for the reason/);
  }
  assert.match(describeSkip({ reason: 'something_new' }), /something_new/);
  assert.match(describeWarning({ reason: 'unresolved_person_ref', ref_id: 'X' }), /"X"/);
});

// ---- errors on the token route ----

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof JetlogApiError, `expected a JetlogApiError, got ${err}`);
    return err;
  }
  assert.fail('the call should have failed');
}

test('403 integration_disabled says the registration is off and keeps the tokens', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');
  const before = h.store.load();

  h.fake.integrationDisabled = true;
  const err = await failure(h.api.importFlights(buildImportPayload(flight)));

  assert.equal(err.status, 403);
  assert.equal(err.code, 'integration_disabled');
  assert.equal(explainError(err).title, 'Jetlog has switched this app off');
  assert.match(explainError(err).lines.join(' '), /support@jetlog.app/);
  assert.deepEqual(h.store.load(), before);
});

test('403 insufficient_scope tells the developer to connect again with more access', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full', { grant: 'import' });

  const err = await failure(h.api.getMe());
  assert.equal(err.status, 403);
  assert.equal(err.code, 'insufficient_scope');
  assert.match(explainError(err).lines.join(' '), /connect again and choose the whole logbook/);
});

test('403 insufficient_access blocks reading and proposing, while import keeps working', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.fullAccessDisabled = true;

  const read = await failure(h.api.getMe());
  assert.equal(read.code, 'insufficient_access');
  assert.equal(explainError(read).title, 'Jetlog no longer lets this app do that');

  const propose = await failure(h.api.proposeChanges(buildRemarksProposal({ entryId: 'e1', label: 'x', remarks: 'y' })));
  assert.equal(propose.code, 'insufficient_access');

  const imported = await h.api.importFlights(buildImportPayload(flight));
  assert.equal(imported.data, 'OK');
});

test('413 says how many entries Jetlog accepts', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  const entries = Array.from({ length: 201 }, (_, n) => ({ type: 'flight', date: '2026-08-14', flight_number: `KL${n}`, from: 'EHAM', to: 'EGLL' }));
  const err = await failure(h.api.importFlights({ entries, people: [] }));

  assert.equal(err.status, 413);
  assert.match(explainError(err).lines.join(' '), /at most 200 entries/);
  assert.match(explainError(err).lines.join(' '), /Nothing was written/);
});

test('413 for too many people names people', () => {
  const err = new JetlogApiError({ status: 413, code: 'too_many_people', body: { error: 'too_many_people', max: 1000 } });
  assert.match(explainError(err).lines.join(' '), /at most 1000 people/);
});

test('429 shows Retry-After and the request is not repeated by itself', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  h.fake.respondOnce('POST', '/api/partner/v1/import', {
    status: 429,
    headers: { 'Retry-After': '30' },
    body: { error: 'rate_limited', retry_after: 30 },
  });
  const err = await failure(h.api.importFlights(buildImportPayload(flight)));

  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 30);
  assert.match(explainError(err).lines.join(' '), /wait 30 seconds/);
  assert.equal(h.fake.requestsTo('/api/partner/v1/import').length, 1);
});

test('a 429 without any wait information asks to slow down', () => {
  const err = JetlogApiError.fromResult({ status: 429, body: { error: 'rate_limited' }, retryAfter: null });
  assert.match(explainError(err).lines.join(' '), /slow down/);
});

test('a 5xx on an import says that sending the flight again is safe', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  h.fake.respondOnce('POST', '/api/partner/v1/import', { status: 503, body: { errors: { detail: 'Service Unavailable' } } });
  const err = await failure(h.api.importFlights(buildImportPayload(flight)));
  assert.match(explainError(err, { context: 'import' }).lines.join(' '), /same flight again is safe/);
});

// ---- read ----

test('me shows who is connected', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  const me = await h.api.getMe();
  assert.equal(me.email, 'pilot@example.com');
  assert.equal(h.fake.requestsTo('/api/partner/v1/me')[0].method, 'GET');
});

test('recent flights come back newest first, from a window of the last 60 days', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  // The clock of the test is 2026-10-09, so the window starts on 2026-08-10.
  h.fake.entries = [entry(1, '2026-01-05'), entry(2, '2026-08-11'), entry(3, '2026-09-01'), entry(4, '2026-10-02')];
  const recent = await h.api.listRecentFlights({ show: 10 });

  assert.deepEqual(
    recent.flights.map((flight) => flight.id),
    ['entry-004', 'entry-003', 'entry-002'],
  );
  assert.equal(recent.loaded, 3);
  assert.equal(recent.incomplete, false);
  assert.equal(h.fake.requestsTo('/api/partner/v1/entries')[0].query.from, '2026-08-10');
  assert.equal(h.fake.requestsTo('/api/partner/v1/entries')[0].query.limit, '200');
});

test('the newest flights are found even when the list is longer than one page', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  h.fake.maxPageSize = 3;
  h.fake.entries = Array.from({ length: 8 }, (_, n) => entry(n + 1, `2026-09-${String(n + 10).padStart(2, '0')}`));
  const recent = await h.api.listRecentFlights({ show: 2 });

  assert.deepEqual(
    recent.flights.map((flight) => flight.id),
    ['entry-008', 'entry-007'],
  );
  assert.equal(recent.loaded, 8);
  assert.equal(h.fake.requestsTo('/api/partner/v1/entries').length, 3);
  assert.equal(h.fake.requestsTo('/api/partner/v1/entries')[1].query.after_id, 'entry-003');
});

test('the sample stops after five pages and says the list may be incomplete', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  h.fake.maxPageSize = 1;
  h.fake.entries = Array.from({ length: 9 }, (_, n) => entry(n + 1, `2026-09-${String(n + 10).padStart(2, '0')}`));
  const recent = await h.api.listRecentFlights({ show: 10 });

  assert.equal(h.fake.requestsTo('/api/partner/v1/entries').length, 5);
  assert.equal(recent.loaded, 5);
  assert.equal(recent.incomplete, true);
});

// ---- propose and status ----

test('a remarks proposal uses the documented operation format', () => {
  assert.deepEqual(buildRemarksProposal({ entryId: 'e1', label: '2026-08-14 KL1023 EHAM to EGLL', remarks: 'Late departure' }), {
    summary: 'Set the remarks of 2026-08-14 KL1023 EHAM to EGLL',
    operations: [{ op: 'update', resource: 'entry', id: 'e1', data: { remarks: 'Late departure' } }],
  });
});

test('a proposal is stored as pending and writes nothing', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const proposal = buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'Late departure' });
  const change = await h.api.proposeChanges(proposal);

  assert.equal(change.status, 'pending');
  assert.ok(change.id);
  assert.match(change.expires_at, /^\d{4}-\d{2}-\d{2}T/);

  const [request] = h.fake.requestsTo('/api/partner/v1/changes');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, proposal);
  // The flight itself is untouched.
  assert.equal(h.fake.entries[0].remarks, null);
});

test('the status of a proposal follows what the pilot did in the app', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  const { id } = await h.api.proposeChanges(buildRemarksProposal({ entryId: 'e1', label: 'KL1', remarks: 'x' }));
  assert.equal((await h.api.getChange(id)).status, 'pending');

  h.fake.setChangeStatus(id, 'applied');
  const applied = await h.api.getChange(id);
  assert.equal(applied.status, 'applied');
  assert.equal(h.fake.requestsTo(`/api/partner/v1/changes/${id}`).length, 2);
});

test('an unknown proposal is a 404 with plain words', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  const err = await failure(h.api.getChange('does-not-exist'));
  assert.equal(err.status, 404);
  assert.equal(explainError(err).title, 'Not found');
});

test('a proposal Jetlog refuses shows the field errors', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  const err = await failure(h.api.proposeChanges({ summary: 'x', operations: [] }));
  assert.equal(err.status, 422);
  assert.deepEqual(explainError(err).lines, ['operations: must not be empty', 'Nothing was written.']);
});

test('the open proposal limit is explained', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.openProposalCap = 0;

  const err = await failure(h.api.proposeChanges(buildRemarksProposal({ entryId: 'e1', label: 'KL1', remarks: 'x' })));
  assert.equal(err.status, 409);
  assert.equal(err.code, 'open_cap_reached');
  assert.match(explainError(err).lines.join(' '), /20 open proposals/);
});

test('every status of a proposal has plain words, and pending says nothing changed', () => {
  for (const status of ['pending', 'applied', 'rejected', 'expired', 'stale', 'failed', 'revoked']) {
    assert.doesNotMatch(describeChangeStatus(status), /does not know/);
  }
  assert.match(describeChangeStatus('pending'), /Nothing has changed/);
  assert.match(describeChangeStatus('pending'), /Jetlog app/);
  assert.match(describeChangeStatus('brand_new'), /brand_new/);
});

test('a 400 shows the error code and says to fix the request', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  h.fake.respondOnce('POST', '/api/partner/v1/import', { status: 400, body: { error: 'invalid_payload' } });
  const err = await failure(h.api.importFlights({ entries: 'nope' }));

  assert.equal(err.code, 'invalid_payload');
  const lines = explainError(err, { context: 'import' }).lines.join(' ');
  assert.match(lines, /invalid_payload/);
  assert.match(lines, /Fix the request/);
  assert.match(lines, /Sending a payload again is safe/);
});

test('a 400 for a body that is not JSON shows the detail Jetlog sends', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  h.fake.respondOnce('POST', '/api/partner/v1/import', { status: 400, body: { errors: { detail: 'Bad Request' } } });
  const err = await failure(h.api.importFlights({ entries: [] }));
  assert.match(explainError(err).lines.join(' '), /Jetlog says: Bad Request/);
});
