// The calls to the token route, /api/partner/v1. Every call goes through the token
// manager, so the access token is fresh, and a 401 gets one refresh and one retry.

import { JetlogApiError } from './errors.js';
import { send } from './http.js';

// Jetlog documents remarks as free text of at most 1000 characters.
export const MAX_REMARKS_LENGTH = 1000;

// Flights come back oldest first and one page holds at most 200 of them. To find
// the newest flights we ask for a recent window and follow the cursor to the end.
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

export function createJetlogApi({ config, tokens, now = Date.now }) {
  async function call(method, path, { query, json } = {}) {
    const url = new URL(config.partnerApiUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);

    const result = await tokens.callWithToken((accessToken) =>
      send(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
      }),
    );

    if (!result.ok) throw JetlogApiError.fromResult(result);
    return result.body;
  }

  // 4. Import. Needs the `import` scope, which every connection has.
  // Returns { data: "OK", skipped: [...], warnings?: [...] }. Read `skipped` and
  // `warnings` every time, because a 200 does not mean every row landed.
  async function importFlights(payload) {
    const body = await call('POST', '/import', { json: payload });
    return { skipped: [], warnings: [], ...body };
  }

  // 5. Who is connected. Needs `read`. Jetlog answers with ids only:
  // { user_id, self_person_id }. There is no name and no email.
  function getMe() {
    return call('GET', '/me');
  }

  // 5. The people of the logbook. Needs `read`.
  async function getPeople() {
    const body = await call('GET', '/people');
    return body.people ?? [];
  }

  // 5. The pilot behind the connection. The name is the person that /me points at
  // (self_person_id), found in the people list. When that person is not in the
  // list, there is no name to show and `name` is null.
  async function getPilot() {
    const [me, people] = await Promise.all([getMe(), getPeople()]);
    const self = people.find((person) => person.id === me.self_person_id);
    const name = self ? [self.first_name, self.last_name].filter(Boolean).join(' ') : '';
    return { userId: me.user_id, selfPersonId: me.self_person_id, name: name || null };
  }

  // 5. The newest flights. Needs `read`.
  async function listRecentFlights({ days = 60, show = 10 } = {}) {
    const from = new Date(now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const loaded = [];
    // Only flights: a proposal cannot target a simulator session.
    let query = { from, type: 'flight', limit: PAGE_SIZE };
    let more = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await call('GET', '/entries', { query });
      loaded.push(...(body.entries ?? []));

      const cursor = body.pagination?.next_cursor;
      more = Boolean(body.pagination?.has_more && cursor);
      if (!more) break;
      query = { from, type: 'flight', limit: PAGE_SIZE, after_date: cursor.date, after_id: cursor.id };
    }

    return { flights: loaded.slice(-show).reverse(), loaded: loaded.length, incomplete: more };
  }

  // 6. Propose changes. Needs `write`. Nothing is written: Jetlog stores a proposal
  // and the pilot decides in the Jetlog app. Returns the pending change.
  async function proposeChanges({ summary, operations }) {
    const body = await call('POST', '/changes', { json: { summary, operations } });
    return requirePendingChange(body);
  }

  // 6. The status of a proposal this connection made. Needs `write`.
  async function getChange(id) {
    const body = await call('GET', `/changes/${encodeURIComponent(id)}`);
    return requirePendingChange(body);
  }

  return { importFlights, getMe, getPeople, getPilot, listRecentFlights, proposeChanges, getChange };
}

function requirePendingChange(body) {
  if (!body?.pending_change?.id) {
    throw new JetlogApiError({ status: 200, message: 'Jetlog answered without a pending_change' });
  }
  return body.pending_change;
}

// The documented payload of one flight. `from` and `to` are required on this route.
// An empty flight number is left out, because the field is optional.
export function buildImportPayload({ date, flightNumber, from, to }) {
  const entry = { type: 'flight', date: String(date ?? '').trim() };
  const number = String(flightNumber ?? '').trim().toUpperCase();
  if (number) entry.flight_number = number;
  entry.from = String(from ?? '').trim().toUpperCase();
  entry.to = String(to ?? '').trim().toUpperCase();
  return { entries: [entry], people: [] };
}

// A change to a flight this app did not add: set its remarks. The operation format
// is the one of every Jetlog proposal: op, resource, id and the fields to change.
export function buildRemarksProposal({ entryId, label, remarks }) {
  return {
    summary: `Set the remarks of ${label}`,
    operations: [{ op: 'update', resource: 'entry', id: entryId, data: { remarks } }],
  };
}
