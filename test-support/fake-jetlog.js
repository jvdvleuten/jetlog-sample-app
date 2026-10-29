// A small stand-in for Jetlog that runs on a local port, so the tests need no
// network and no account. It follows the answers of the real server, and it checks
// what the sample sends (PKCE, redirect address, resource, scopes) the way the real
// server does, so a mistake in the sample shows up as a failing test.

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

// A flight as the read routes send it: the fields of the app's own query answer,
// plus is_own. There is no signature, attachment, photo, entry_source or feed
// (*_system) field in it, on purpose.
export function makeEntry(n, date, overrides = {}) {
  const id = `entry-${String(n).padStart(3, '0')}`;
  return {
    id,
    version: 1,
    type: 'flight',
    date,
    is_own: false,
    flight_number: `KL${n}`,
    registration: null,
    from: 'EHAM',
    to: 'EGLL',
    actual_from: null,
    actual_to: null,
    off_blocks: null,
    airborne: null,
    touchdown: null,
    on_blocks: null,
    update_flight_data: true,
    derived: { date, registration: null, from: 'EHAM', to: 'EGLL', off_blocks: null, airborne: null, touchdown: null, on_blocks: null },
    is_completed: false,
    takeoffs_and_landings: null,
    approaches: [],
    remarks: null,
    people: [],
    is_deleted: false,
    updated_at: '2026-10-01T10:00:00Z',
    calculated_times: null,
    ...overrides,
  };
}

const sha256url = (text) => createHash('sha256').update(text, 'ascii').digest('base64url');

export async function startFakeJetlog() {
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const changes = new Map();
  const oneOffAnswers = [];
  let sequence = 0;

  const fake = {
    url: '',
    // Every request, in order: { method, path, query, headers, body }.
    requests: [],
    refreshCalls: 0,
    revokeCalls: [],
    tokenLifetimeSeconds: 3600,
    // 'ok', 'invalid_grant', 'unauthorized_client', 'rate_limited' or 'server_error'
    refreshBehaviour: 'ok',
    refreshDelayMs: 0,
    // Set to switch off reading and proposing, like a registration that lost whole logbook access.
    fullAccessDisabled: false,
    integrationDisabled: false,
    // Whole logbook access enabled for the app. When it is not, a request for the
    // whole logbook is quietly narrowed to own flights, without an error.
    wholeLogbookEnabled: true,
    // The pilot of the account. /me gives the ids, the name is in /people.
    pilotId: 'user-1',
    people: [
      {
        id: 'user-1',
        first_name: 'Anna',
        last_name: 'de Vries',
        default_role: 'Captain',
        employee_number: null,
        is_imported_from_other_logbook: false,
      },
    ],
    entries: [],
    maxPageSize: 200,
    // What the logbook would show for a key after a proposal is approved. The default
    // is the proposed value, except on a flight that follows the flight feed, where
    // the feed decides the keys in FEED_KEYS. A test can replace it to make Jetlog
    // show something else.
    shownValue: null,
    // Open proposals allowed for this connection.
    openProposalCap: 5,
    // Called for every request that reaches an API route, after the token is accepted.
    onApiRequest: null,
    importResponse: null,

    // Plays the part of the Jetlog sign-in page. Returns the address Jetlog would send the pilot back to.
    approve(authorizeUrl, { scope } = {}) {
      const query = new URL(authorizeUrl).searchParams;
      const expect = (name, value) => {
        if (query.get(name) !== value) {
          throw new Error(`authorize request: ${name} should be ${value}, was ${query.get(name)}`);
        }
      };
      expect('response_type', 'code');
      expect('code_challenge_method', 'S256');
      expect('resource', `${fake.url}/api/partner/v1`);
      for (const name of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'scope']) {
        if (!query.get(name)) throw new Error(`authorize request has no ${name}`);
      }

      const code = `code_${(sequence += 1)}`;
      codes.set(code, {
        clientId: query.get('client_id'),
        redirectUri: query.get('redirect_uri'),
        resource: query.get('resource'),
        challenge: query.get('code_challenge'),
        scope: scope ?? narrowed(query.get('scope')),
        used: false,
        issued: [],
      });
      const back = new URL(query.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('iss', fake.url);
      back.searchParams.set('state', query.get('state'));
      return back.toString();
    },

    // The pilot says no, or Jetlog refuses the request.
    deny(authorizeUrl, error = 'access_denied', description = 'The user denied the request') {
      const query = new URL(authorizeUrl).searchParams;
      const back = new URL(query.get('redirect_uri'));
      back.searchParams.set('error', error);
      back.searchParams.set('error_description', description);
      back.searchParams.set('iss', fake.url);
      back.searchParams.set('state', query.get('state'));
      return back.toString();
    },

    // The pilot removes the app in Jetlog: every refresh token is revoked, so the
    // access tokens answer 401 and a refresh answers invalid_grant.
    pilotRemovesApp() {
      for (const record of refreshTokens.values()) record.revoked = true;
    },

    // Every access token handed out so far now answers 401.
    expireAccessTokens() {
      for (const record of accessTokens.values()) record.expired = true;
    },

    // The next request to this method and path gets this answer instead.
    respondOnce(method, path, answer) {
      oneOffAnswers.push({ method, path, answer });
    },

    // What the pilot does in the Jetlog app. Approving can be partial: pass the
    // indices of the operations the pilot picked. An approved remarks change lands
    // on the fake logbook.
    approveChange(id, { operationIndices } = {}) {
      const change = changes.get(id);
      const picked = operationIndices ?? change.operations.map((_, index) => index);
      change.status = 'applied';
      change.decided_at = new Date().toISOString();
      change.applied_batch_id = randomUUID();
      change.operations = change.operations.map((operation, index) => ({ ...operation, applied: picked.includes(index) }));
      change.counts = { creates: 0, updates: picked.length, deletes: 0 };
      for (const index of picked) {
        const operation = change.operations[index];
        const entry = fake.entries.find((row) => row.id === operation.id);
        if (entry) Object.assign(entry, operation.data);
      }
    },

    // Any other outcome: 'rejected', 'expired', 'stale', 'failed' or 'revoked'.
    setChangeStatus(id, status, extra = {}) {
      Object.assign(changes.get(id), { status, decided_at: new Date().toISOString(), ...extra });
    },

    changes,
    refreshTokens,

    requestsTo(path) {
      return fake.requests.filter((request) => request.path === path);
    },

    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };

  // The full set only when it was asked for in full and Jetlog enabled it for the
  // app. Anything else becomes plain import, with no error.
  function narrowed(requested) {
    const scopes = requested.split(' ');
    const full = scopes.includes('read') && scopes.includes('write');
    return full && fake.wholeLogbookEnabled ? 'import read write' : 'import';
  }

  function issueTokens(scope, source = {}) {
    const accessToken = `jlp_access_${(sequence += 1)}`;
    const refreshToken = `jlr_refresh_${(sequence += 1)}`;
    accessTokens.set(accessToken, { scope, expired: false, refreshToken });
    refreshTokens.set(refreshToken, { scope, used: false, revoked: false });
    source.issued?.push(accessToken, refreshToken);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: fake.tokenLifetimeSeconds,
      refresh_token: refreshToken,
      scope,
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function tokenEndpoint(body, reply) {
    if (body.grant_type === 'authorization_code') {
      const record = codes.get(body.code);
      const valid =
        record &&
        !record.used &&
        body.client_id === record.clientId &&
        body.redirect_uri === record.redirectUri &&
        body.resource === record.resource &&
        typeof body.code_verifier === 'string' &&
        sha256url(body.code_verifier) === record.challenge;

      if (record?.used) {
        // Presenting a code twice also ends the tokens the first exchange issued.
        for (const token of record.issued) {
          accessTokens.delete(token);
          if (refreshTokens.has(token)) refreshTokens.get(token).revoked = true;
        }
      }
      if (!valid) return reply(400, { error: 'invalid_grant' });
      record.used = true;
      return reply(200, issueTokens(record.scope, record));
    }

    if (body.grant_type === 'refresh_token') {
      fake.refreshCalls += 1;
      if (fake.refreshDelayMs) await sleep(fake.refreshDelayMs);

      if (fake.refreshBehaviour === 'unauthorized_client') return reply(400, { error: 'unauthorized_client' });
      if (fake.refreshBehaviour === 'invalid_grant') return reply(400, { error: 'invalid_grant' });
      if (fake.refreshBehaviour === 'server_error') return reply(500, { errors: { detail: 'Internal Server Error' } });
      if (fake.refreshBehaviour === 'rate_limited') {
        return reply(429, { error: 'rate_limited', retry_after: 7 }, { 'Retry-After': '7' });
      }

      const record = refreshTokens.get(body.refresh_token);
      // A refresh token works once. Reusing a spent one is invalid_grant.
      if (!record || record.used || record.revoked) return reply(400, { error: 'invalid_grant' });
      record.used = true;
      return reply(200, issueTokens(record.scope));
    }

    return reply(400, { error: 'unsupported_grant_type' });
  }

  function revokeEndpoint(body, reply) {
    fake.revokeCalls.push(body);
    const record = refreshTokens.get(body.token);
    if (record) record.revoked = true;
    return reply(200, null);
  }

  // ---- the token route, /api/partner/v1 ----

  function authenticate(request, reply) {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    const token = bearer ? accessTokens.get(bearer) : null;
    const refresh = token ? refreshTokens.get(token.refreshToken) : null;
    if (!token || token.expired || refresh?.revoked) {
      reply(401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      return null;
    }
    return token;
  }

  // The checks of every partner route, in the order of the real server: the token
  // (done before), the scope, the registration, and for reading and proposing
  // whether the whole logbook is still enabled for the app.
  function needs(token, scope, reply) {
    if (!token.scope.split(' ').includes(scope)) {
      reply(403, { error: 'insufficient_scope' });
      return false;
    }
    if (fake.integrationDisabled) {
      reply(403, { error: 'integration_disabled' });
      return false;
    }
    if (scope !== 'import' && fake.fullAccessDisabled) {
      reply(403, { error: 'insufficient_access' });
      return false;
    }
    return true;
  }

  function apiRoute(request, reply) {
    const token = authenticate(request, reply);
    if (!token) return;
    fake.onApiRequest?.(request);

    const { method, path, query, body } = request;
    const route = path.replace('/api/partner/v1', '');

    // Checked right after the token, on every route, like Jetlog does.
    const nul = findNul(body, '');
    if (nul) {
      const field = route === '/changes' ? nul.path.replace(/^operations\[\d+\]\.(data\.)?/, '') : nul.path;
      return reply(422, {
        error: {
          message: 'Text must not contain the NUL character (U+0000) and must be valid UTF-8',
          code: 'invalid_text',
          errors: [{ index: nul.index, field, message: 'must not contain the NUL character (U+0000)' }],
        },
      });
    }

    if (method === 'POST' && route === '/import') {
      if (!needs(token, 'import', reply)) return;
      if ((body.entries ?? []).length > 200) return reply(413, { error: 'too_many_entries', max: 200 });
      return reply(200, fake.importResponse ?? { data: 'OK', skipped: [] });
    }

    if (method === 'GET' && route === '/me') {
      if (!needs(token, 'read', reply)) return;
      // Ids only. There is no email and no name.
      return reply(200, { user_id: fake.pilotId, self_person_id: fake.pilotId });
    }

    if (method === 'GET' && route === '/people') {
      if (!needs(token, 'read', reply)) return;
      return reply(200, { people: fake.people });
    }

    if (method === 'GET' && route === '/entries') {
      if (!needs(token, 'read', reply)) return;
      return reply(200, entriesPage(query));
    }

    if (method === 'POST' && route === '/changes') {
      if (!needs(token, 'write', reply)) return;
      return proposeChange(body, reply);
    }

    const change = method === 'GET' ? /^\/changes\/(.+)$/.exec(route) : null;
    if (change) {
      if (!needs(token, 'write', reply)) return;
      const found = changes.get(change[1]);
      if (!found) return reply(404, { error: { message: 'Pending change not found' } });
      return reply(200, { pending_change: found });
    }

    return reply(404, { error: 'not_found' });
  }

  // Oldest first, like the real list. The cursor is the last row of the page.
  function entriesPage(query) {
    const limit = Math.min(Number(query.limit ?? 50), fake.maxPageSize);
    const sorted = [...fake.entries]
      // Deleted flights are never returned, whatever include_deleted says.
      .filter((entry) => !entry.is_deleted)
      .filter((entry) => !query.type || entry.type === query.type)
      .filter((entry) => !query.from || entry.date >= query.from)
      .sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))
      .filter((entry) => !query.after_date || entry.date + entry.id > query.after_date + query.after_id);

    const page = sorted.slice(0, limit);
    const hasMore = sorted.length > limit;
    const last = page[page.length - 1];
    return {
      entries: page,
      pagination: { limit, has_more: hasMore, next_cursor: hasMore ? { date: last.date, id: last.id } : null },
    };
  }

  // Files, photos, signatures and signing links are refused for every connected app,
  // before anything else is looked at.
  function refusedScope(operations) {
    const filesKeys = ['photo_attachment_id', 'photo_sha256'];
    const signatureKeys = ['signature', 'signature_attachment_id', 'signature_sha256', 'signature_waived'];
    for (const operation of operations) {
      const keys = Object.keys(operation.data ?? {});
      if (operation.resource === 'entry_attachment' || keys.some((key) => filesKeys.includes(key))) return 'files';
      if (operation.resource === 'signature_link' || keys.some((key) => signatureKeys.includes(key))) return 'signatures';
    }
    return null;
  }

  // What an app may put in a proposal: entries and people, and only the fields the
  // pilot is shown a before and after value for.
  const ENTRY_KEYS = ['type', 'flight_number', 'date', 'registration', 'from', 'to', 'off_blocks', 'airborne', 'touchdown', 'on_blocks', 'remarks', 'people', 'is_deleted'];
  const PERSON_KEYS = ['first_name', 'last_name', 'default_role', 'employee_number', 'is_imported_from_other_logbook', 'is_deleted'];
  // On a flight that follows the flight feed, the feed decides these.
  const FEED_KEYS = ['date', 'from', 'to', 'registration', 'off_blocks', 'airborne', 'touchdown', 'on_blocks'];

  // The usual cleaning before a value is compared: registration cleaned, airport
  // codes upper-cased, text trimmed.
  function clean(key, value) {
    if (typeof value !== 'string') return value;
    if (key === 'registration') return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (key === 'from' || key === 'to') return value.trim().toUpperCase();
    return value.trim();
  }

  // The value the logbook would show for this key once the proposal is approved.
  function shownAfter(resource, target, key, proposed) {
    if (fake.shownValue) return fake.shownValue(resource, target, key, proposed);
    if (resource === 'entry' && target.update_flight_data === true && FEED_KEYS.includes(key)) {
      return target.derived?.[key] ?? null;
    }
    return clean(key, proposed);
  }

  function proposalErrors(operations) {
    const errors = [];
    const refuse = (index, field, message) => errors.push({ field, index, message });
    const seen = new Set();

    for (const [index, operation] of operations.entries()) {
      if (!['create', 'update', 'delete'].includes(operation.op)) {
        refuse(index, 'op', 'must be one of ["create", "update", "delete"]');
        continue;
      }
      if (!['entry', 'person'].includes(operation.resource)) {
        refuse(index, 'resource', `connected apps cannot propose changes to ${operation.resource}`);
        continue;
      }

      if (operation.id) {
        const key = `${operation.resource}:${operation.id}`;
        if (seen.has(key)) refuse(index, 'id', `duplicate ${operation.resource} id ${operation.id} within this proposal`);
        seen.add(key);
      }

      const data = operation.data ?? {};
      const allowed = operation.resource === 'entry' ? ENTRY_KEYS : PERSON_KEYS;

      if (operation.resource === 'entry') {
        if (operation.op === 'create' && data.type !== 'flight') {
          refuse(index, 'type', 'connected apps can only add flights (type "flight")');
        } else if (operation.op !== 'create' && 'type' in data && data.type !== 'flight') {
          refuse(index, 'type', 'connected apps can only change flights (type "flight")');
        }
      }
      for (const key of Object.keys(data)) {
        if (!allowed.includes(key)) refuse(index, key, `connected apps cannot propose ${key}`);
      }
      if (Array.isArray(data.people) && data.people.length > 20) {
        refuse(index, 'people', 'at most 20 crew members per flight');
      }

      if (operation.op === 'create') continue;
      if (typeof operation.id !== 'string') {
        refuse(index, 'id', 'required for update/delete');
        continue;
      }

      const target =
        operation.resource === 'entry'
          ? fake.entries.find((row) => row.id === operation.id && !row.is_deleted && row.type === 'flight')
          : fake.people.find((person) => person.id === operation.id);
      if (!target) {
        refuse(index, 'id', `${operation.resource} ${operation.id} not found`);
        continue;
      }

      // The rule: after approval the logbook must show exactly the value proposed.
      // Repeating a value that is already there is fine.
      const word = operation.resource === 'entry' ? 'flight' : 'person';
      for (const key of Object.keys(data).filter((candidate) => allowed.includes(candidate) && candidate !== 'type' && candidate !== 'people')) {
        if (shownAfter(operation.resource, target, key, data[key]) === clean(key, data[key])) continue;
        const feed = operation.resource === 'entry' && target.update_flight_data === true && FEED_KEYS.includes(key);
        refuse(
          index,
          key,
          feed
            ? `Jetlog would show a different value than the one proposed for this ${word}, because the flight follows the flight feed, so connected apps cannot propose it`
            : `Jetlog would show a different value than the one proposed for this ${word}, so connected apps cannot propose it`,
        );
      }
    }
    return errors;
  }

  // The first string with a NUL: its path in the body, and the first list position on the way.
  function findNul(value, path, index = null) {
    if (typeof value === 'string') return value.includes('\u0000') ? { path, index } : null;
    if (value === null || typeof value !== 'object') return null;
    for (const [key, child] of Object.entries(value)) {
      const isListItem = Array.isArray(value);
      const found = findNul(child, isListItem ? `${path}[${key}]` : path ? `${path}.${key}` : key, isListItem && index === null ? Number(key) : index);
      if (found) return found;
    }
    return null;
  }

  function proposeChange(body, reply) {
    const operations = Array.isArray(body.operations) ? body.operations : [];

    if (operations.length > 200) {
      return reply(413, { error: { code: 'too_many_entries', message: `Too many operations (${operations.length})` } });
    }

    const refused = refusedScope(operations);
    if (refused) {
      return reply(403, {
        error: 'insufficient_scope',
        message: `Connected apps never get the "${refused}" permission. Nothing was changed.`,
        missing_scopes: [refused],
      });
    }

    const errors = operations.length === 0 ? [{ index: null, field: 'operations', message: 'must not be empty' }] : proposalErrors(operations);
    if (errors.length) return reply(422, { error: { message: 'Invalid operations', errors } });

    const open = [...changes.values()].filter((change) => change.status === 'pending').length;
    if (open >= fake.openProposalCap) {
      return reply(409, { error: { code: 'open_cap_reached', message: 'Too many open pending changes' } });
    }

    // The preview a partner gets: before, after and changed_fields per item, and no
    // raw_before and no signature or photo state.
    const preview = operations.map((operation, index) => {
      const before = fake.entries.find((row) => row.id === operation.id);
      const changed = Object.keys(operation.data ?? {});
      return {
        index,
        op: operation.op,
        resource: operation.resource,
        id: operation.id,
        before: before ? { id: before.id, date: before.date, flight_number: before.flight_number, from: before.from, to: before.to, remarks: before.remarks } : null,
        after: before ? { id: before.id, date: before.date, flight_number: before.flight_number, from: before.from, to: before.to, remarks: before.remarks, ...operation.data } : null,
        changed_fields: changed,
      };
    });

    const now = Date.now();
    const change = {
      id: randomUUID(),
      status: 'pending',
      client_kind: 'partner',
      client_name: 'Jetlog Sample App',
      summary: body.summary,
      counts: { creates: 0, updates: operations.length, deletes: 0 },
      operations: operations.map((operation, index) => ({ index, ...operation })),
      preview,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      decided_at: null,
      applied_batch_id: null,
      reverted_indices: [],
      error: null,
    };
    changes.set(change.id, change);
    return reply(201, { pending_change: change });
  }

  // ---- plumbing ----

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] ?? '';
    const body = !text
      ? {}
      : contentType.includes('json')
        ? JSON.parse(text)
        : Object.fromEntries(new URLSearchParams(text));

    // The two POST routes have a size limit, checked before anything else.
    const limit = { '/api/partner/v1/changes': 256 * 1024, '/api/partner/v1/import': 2 * 1024 * 1024 }[url.pathname];
    if (req.method === 'POST' && limit && Buffer.byteLength(text) > limit) {
      fake.requests.push({ method: req.method, path: url.pathname, query: {}, headers: req.headers, body: null });
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'payload_too_large', max_bytes: limit }));
    }

    const request = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    };
    fake.requests.push(request);

    const reply = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload === null ? '' : JSON.stringify(payload));
    };

    const oneOff = oneOffAnswers.findIndex((item) => item.method === request.method && item.path === request.path);
    if (oneOff !== -1) {
      const { answer } = oneOffAnswers.splice(oneOff, 1)[0];
      return reply(answer.status, answer.body ?? null, answer.headers);
    }

    if (request.method === 'POST' && request.path === '/oauth/token') return tokenEndpoint(body, reply);
    if (request.method === 'POST' && request.path === '/oauth/revoke') return revokeEndpoint(body, reply);
    if (request.path.startsWith('/api/partner/v1/')) return apiRoute(request, reply);
    return reply(404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  return fake;
}
