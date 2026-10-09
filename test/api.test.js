import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DisconnectedError, explainError, JetlogApiError } from '../src/errors.js';
import { buildImportPayload, buildRemarksProposal } from '../src/jetlog-api.js';
import { describeChangeStatus, describeSkip, describeWarning } from '../src/plain-words.js';
import { importResultFlash } from '../src/views.js';
import { makeEntry } from '../test-support/fake-jetlog.js';
import { setup } from '../test-support/harness.js';

const flight = { date: '2026-08-14', flightNumber: 'kl1023', from: 'eham', to: 'egll' };

const entry = makeEntry;

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

  const propose = await failure(h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'x', remarks: 'y' })));
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

test('me answers with ids only, and the name comes from the people list', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  assert.deepEqual(await h.api.getMe(), { user_id: 'user-1', self_person_id: 'user-1' });

  const pilot = await h.api.getPilot();
  assert.deepEqual(pilot, { userId: 'user-1', selfPersonId: 'user-1', name: 'Anna de Vries' });
  assert.equal(h.fake.requestsTo('/api/partner/v1/me')[1].method, 'GET');
  assert.equal(h.fake.requestsTo('/api/partner/v1/people').length, 1);
});

test('the pilot is found by self_person_id, not by position in the list', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  h.fake.pilotId = 'user-9';
  h.fake.people = [
    { id: 'someone-else', first_name: 'Bram', last_name: 'Jansen' },
    { id: 'user-9', first_name: 'Carla', last_name: 'Smit' },
  ];
  assert.equal((await h.api.getPilot()).name, 'Carla Smit');
});

test('when the pilot is not in the people list there is no name, and no failure', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  h.fake.people = [{ id: 'someone-else', first_name: 'Bram', last_name: 'Jansen' }];
  assert.deepEqual(await h.api.getPilot(), { userId: 'user-1', selfPersonId: 'user-1', name: null });

  h.fake.people = [{ id: 'user-1', first_name: '', last_name: null }];
  assert.equal((await h.api.getPilot()).name, null);
});

test('a missing read scope stops the pilot lookup with the same explanation', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full', { grant: 'import' });

  const err = await failure(h.api.getPilot());
  assert.equal(err.code, 'insufficient_scope');
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
  // Every page asks for flights only, not just the first.
  assert.ok(h.fake.requestsTo('/api/partner/v1/entries').every((request) => request.query.type === 'flight'));
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

  h.fake.entries = [entry(1, '2026-09-01')];
  const { id } = await h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'x' }));
  assert.equal((await h.api.getChange(id)).status, 'pending');

  h.fake.approveChange(id);
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

test('the sixth open proposal of a connection is refused, and the sentence says five', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const proposal = buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'x' });
  for (let count = 0; count < 5; count += 1) await h.api.proposeChanges(proposal);

  const err = await failure(h.api.proposeChanges(proposal));
  assert.equal(err.status, 409);
  assert.equal(err.code, 'open_cap_reached');
  assert.match(explainError(err).lines.join(' '), /This connection already has 5 open proposals/);
});

test('every status of a proposal has plain words, and pending says nothing changed', () => {
  for (const status of ['pending', 'applied', 'rejected', 'expired', 'stale', 'failed', 'revoked']) {
    assert.doesNotMatch(describeChangeStatus(status), /does not know/);
  }
  assert.match(describeChangeStatus('pending'), /Nothing has changed/);
  assert.match(describeChangeStatus('pending'), /Jetlog app/);
  assert.match(describeChangeStatus('brand_new'), /brand_new/);
});

test('stale, failed and revoked say what they mean', () => {
  // stale: something the proposal touches changed after it was made, nothing was applied.
  assert.match(describeChangeStatus('stale'), /changed after the proposal was made/);
  assert.match(describeChangeStatus('stale'), /Nothing was applied/);
  // failed: applying it failed.
  assert.match(describeChangeStatus('failed'), /Applying the proposal failed/);
  // revoked: the pilot disconnected the app.
  assert.match(describeChangeStatus('revoked'), /pilot disconnected this app/);
  assert.match(describeChangeStatus('revoked'), /Nothing was applied/);
});

test('an applied proposal says which operations were applied, because the pilot can approve only some', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01'), entry(2, '2026-09-02')];

  const change = await h.api.proposeChanges({
    summary: 'Two remarks',
    operations: [
      { op: 'update', resource: 'entry', id: 'entry-001', data: { remarks: 'one' } },
      { op: 'update', resource: 'entry', id: 'entry-002', data: { remarks: 'two' } },
    ],
  });
  // Before a decision the operations carry no applied flag.
  assert.ok(change.operations.every((operation) => !('applied' in operation)));

  h.fake.approveChange(change.id, { operationIndices: [1] });
  const decided = await h.api.getChange(change.id);

  assert.equal(decided.status, 'applied');
  assert.deepEqual(decided.operations.map((operation) => operation.applied), [false, true]);
  assert.equal(h.fake.entries[0].remarks, null);
  assert.equal(h.fake.entries[1].remarks, 'two');
});

test('the preview of a proposal has before, after and changed_fields, and no raw_before', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01', { remarks: 'old note' })];

  const change = await h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'new note' }));
  const [item] = change.preview;

  assert.deepEqual(Object.keys(item).sort(), ['after', 'before', 'changed_fields', 'id', 'index', 'op', 'resource']);
  assert.deepEqual(item.changed_fields, ['remarks']);
  assert.equal(item.before.remarks, 'old note');
  assert.equal(item.after.remarks, 'new note');
});

test('a proposal that touches files or signatures is refused, and the sentence says so', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const photo = await failure(
    h.api.proposeChanges({ summary: 'x', operations: [{ op: 'update', resource: 'person', id: 'user-1', data: { photo_attachment_id: 'abc' } }] }),
  );
  assert.equal(photo.status, 403);
  assert.equal(photo.code, 'insufficient_scope');
  assert.deepEqual(photo.missingScopes, ['files']);
  assert.equal(explainError(photo).title, 'Connected apps cannot change that');
  assert.match(explainError(photo).lines.join(' '), /files and photos/);
  assert.match(explainError(photo).lines.join(' '), /Nothing was changed/);

  const link = await failure(
    h.api.proposeChanges({ summary: 'x', operations: [{ op: 'create', resource: 'signature_link', data: { entry_ids: ['entry-001'] } }] }),
  );
  assert.deepEqual(link.missingScopes, ['signatures']);
  assert.match(explainError(link).lines.join(' '), /signatures and signing links/);

  const signed = await failure(
    h.api.proposeChanges({ summary: 'x', operations: [{ op: 'update', resource: 'entry', id: 'entry-001', data: { signature_waived: true } }] }),
  );
  assert.deepEqual(signed.missingScopes, ['signatures']);
});

test('a plain insufficient_scope without missing_scopes keeps the connect again advice', () => {
  const err = JetlogApiError.fromResult({ status: 403, body: { error: 'insufficient_scope' }, retryAfter: null });
  assert.deepEqual(err.missingScopes, []);
  assert.match(explainError(err).lines.join(' '), /connect again/);
});

test('more than 200 operations is a nested 413 and is explained', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  const operations = Array.from({ length: 201 }, (_, n) => ({ op: 'update', resource: 'entry', id: `entry-${n}`, data: { remarks: 'x' } }));
  const err = await failure(h.api.proposeChanges({ summary: 'x', operations }));

  assert.equal(err.status, 413);
  assert.equal(err.code, 'too_many_entries');
  assert.equal(explainError(err).title, 'The proposal is too big');
  assert.match(explainError(err).lines.join(' '), /Too many operations \(201\)\. A proposal holds at most 200 operations/);
});

test('a proposal for a flight that does not exist is a 422 with the field error', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');

  const err = await failure(h.api.proposeChanges(buildRemarksProposal({ entryId: 'nope', label: 'x', remarks: 'y' })));
  assert.equal(err.status, 422);
  assert.deepEqual(explainError(err).lines, ['Operation 1: entry nope not found', 'Nothing was written.']);
});

test('the checks run in the order of the real server: scope first, then registration, then access', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full', { grant: 'import' });

  // No read scope and a disabled registration: the scope answer comes first.
  h.fake.integrationDisabled = true;
  assert.equal((await failure(h.api.getMe())).code, 'insufficient_scope');

  // With the scope, the registration answer comes before the access answer.
  const full = await setup();
  t.after(full.cleanup);
  await full.connect('full');
  full.fake.integrationDisabled = true;
  full.fake.fullAccessDisabled = true;
  assert.equal((await failure(full.api.getMe())).code, 'integration_disabled');
});

// ---- what an app may propose ----

const propose = (h, operation) => h.api.proposeChanges({ summary: 'x', operations: [operation] });
const update = (data, id = 'entry-001') => ({ op: 'update', resource: 'entry', id, data });

test('a field an app may not propose is refused with Jetlog own words, and the page shows them', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const err = await failure(propose(h, update({ manual_times: true })));
  assert.equal(err.status, 422);
  assert.deepEqual(err.fieldErrors, [{ field: 'manual_times', index: 0, message: 'connected apps cannot propose manual_times' }]);
  assert.deepEqual(explainError(err).lines, ['Operation 1: connected apps cannot propose manual_times', 'Nothing was written.']);
  assert.equal(explainError(err).title, 'Jetlog rejected the proposal');
});

test('an unknown key is refused by name, and nothing else of the operation is dropped quietly', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const err = await failure(propose(h, update({ remarks: 'ok', surprise: 1, fuel_used: 5 })));
  assert.deepEqual(
    err.fieldErrors.map((error) => error.field),
    ['surprise', 'fuel_used'],
  );
  assert.equal(h.fake.changes.size, 0);
});

test('a time on a flight that follows the flight feed is refused, with the reason', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01', { update_flight_data: true })];

  const err = await failure(propose(h, update({ off_blocks: '10:05' })));
  assert.equal(err.status, 422);
  assert.match(
    explainError(err).lines[0],
    /^Operation 1: off_blocks would change nothing you can see in the logbook for this flight \(it follows the flight feed\), so connected apps cannot propose it$/,
  );
});

test('the same time is accepted on a flight that is not tracked', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01', { update_flight_data: false })];

  const change = await propose(h, update({ off_blocks: '10:05' }));
  assert.equal(change.status, 'pending');
  assert.deepEqual(change.preview[0].changed_fields, ['off_blocks']);
});

test('remarks, the field of the sample, is accepted on a tracked flight', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01', { update_flight_data: true })];

  const change = await h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'Late' }));
  assert.equal(change.status, 'pending');
});

test('aircraft, the type of a flight and the crew size have refusals of their own', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const aircraft = await failure(propose(h, { op: 'update', resource: 'aircraft', id: 'a1', data: { registration: 'PHBXD' } }));
  assert.equal(explainError(aircraft).lines[0], 'Operation 1: connected apps cannot propose changes to aircraft');

  const created = await failure(propose(h, { op: 'create', resource: 'entry', data: { type: 'fstd', date: '2026-09-02' } }));
  assert.equal(explainError(created).lines[0], 'Operation 1: connected apps can only add flights (type "flight")');

  const changed = await failure(propose(h, update({ type: 'fstd' })));
  assert.equal(explainError(changed).lines[0], 'Operation 1: connected apps can only change flights (type "flight")');

  const crew = Array.from({ length: 21 }, (_, n) => ({ person_id: `p${n}`, role: 'FO' }));
  const tooMany = await failure(propose(h, update({ people: crew })));
  assert.equal(explainError(tooMany).lines[0], 'Operation 1: at most 20 crew members per flight');
});

test('a simulator session or a deleted flight cannot be the target of a proposal', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01', { type: 'fstd' }), entry(2, '2026-09-02', { is_deleted: true })];

  const simulator = await failure(h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'x', remarks: 'y' })));
  assert.equal(explainError(simulator).lines[0], 'Operation 1: entry entry-001 not found');
  const deleted = await failure(h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-002', label: 'x', remarks: 'y' })));
  assert.equal(explainError(deleted).lines[0], 'Operation 1: entry entry-002 not found');
});

test('every refused operation of a proposal is listed with its own number', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01'), entry(2, '2026-09-02')];

  const err = await failure(
    h.api.proposeChanges({
      summary: 'x',
      operations: [update({ remarks: 'fine' }), update({ ifr: true }, 'entry-002')],
    }),
  );
  assert.deepEqual(explainError(err).lines, ['Operation 2: connected apps cannot propose ifr', 'Nothing was written.']);
});

// ---- the size of a request ----

test('an import body over 2 MB is a flat 413 that names the limit', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('own');

  const entries = [{ type: 'flight', date: '2026-08-14', flight_number: 'KL1', from: 'EHAM', to: 'EGLL', remarks: 'x'.repeat(2 * 1024 * 1024) }];
  const err = await failure(h.api.importFlights({ entries, people: [] }));

  assert.equal(err.status, 413);
  assert.equal(err.code, 'payload_too_large');
  assert.equal(err.body.max_bytes, 2097152);
  assert.equal(explainError(err).title, 'The request body is too big');
  assert.match(explainError(err).lines.join(' '), /at most 2 MB in one request/);
  assert.match(explainError(err).lines.join(' '), /Nothing was written/);
});

test('a proposal body over 256 KB is a flat 413 that names the limit', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  const err = await failure(h.api.proposeChanges({ summary: 'x'.repeat(256 * 1024), operations: [update({ remarks: 'x' })] }));
  assert.equal(err.status, 413);
  assert.equal(err.body.max_bytes, 262144);
  assert.match(explainError(err).lines.join(' '), /at most 256 KB in one request/);
});

test('a 413 payload_too_large without max_bytes still reads sensibly', () => {
  const err = JetlogApiError.fromResult({ status: 413, body: { error: 'payload_too_large' }, retryAfter: null });
  assert.match(explainError(err).lines[0], /at most a fixed number of bytes/);
});

// ---- the status poll is rate limited ----

test('a 429 on the status poll carries its wait, and the poll is not repeated by itself', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];
  const { id } = await h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'x' }));

  h.fake.respondOnce('GET', `/api/partner/v1/changes/${id}`, { status: 429, headers: { 'Retry-After': '9' }, body: { error: 'rate_limited', retry_after: 9 } });
  const err = await failure(h.api.getChange(id));

  assert.equal(err.retryAfter, 9);
  assert.match(explainError(err).lines.join(' '), /wait 9 seconds/);
  assert.equal(h.fake.requestsTo(`/api/partner/v1/changes/${id}`).length, 1);
});

// ---- a proposal after the pilot removed the app ----

test('a proposal after the pilot removed the app ends as disconnected after one refresh, not in a loop', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.connect('full');
  h.fake.entries = [entry(1, '2026-09-01')];

  h.fake.pilotRemovesApp();
  await assert.rejects(
    h.api.proposeChanges(buildRemarksProposal({ entryId: 'entry-001', label: 'KL1', remarks: 'x' })),
    (err) => err instanceof DisconnectedError,
  );

  assert.equal(h.fake.requestsTo('/api/partner/v1/changes').length, 1);
  assert.equal(h.fake.refreshCalls, 1);
  assert.equal(h.fake.changes.size, 0);
  assert.equal(h.store.load(), null);
});
