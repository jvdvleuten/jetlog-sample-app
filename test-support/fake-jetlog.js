// A small stand-in for Jetlog that runs on a local port, so the tests need no
// network and no account. It follows the shapes in the Jetlog guide, and it checks
// what the sample sends (PKCE, redirect address, resource, scopes) the way the real
// server does, so a mistake in the sample shows up as a failing test.

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

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
    entries: [],
    maxPageSize: 200,
    openProposalCap: 20,
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
        scope: scope ?? query.get('scope'),
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

    // Every access token handed out so far now answers 401.
    expireAccessTokens() {
      for (const record of accessTokens.values()) record.expired = true;
    },

    // The next request to this method and path gets this answer instead.
    respondOnce(method, path, answer) {
      oneOffAnswers.push({ method, path, answer });
    },

    setChangeStatus(id, status) {
      changes.get(id).status = status;
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

  function needs(token, scope, reply) {
    if (fake.integrationDisabled) {
      reply(403, { error: 'integration_disabled' });
      return false;
    }
    if (!token.scope.split(' ').includes(scope)) {
      reply(403, { error: 'insufficient_scope' });
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

    if (method === 'POST' && route === '/import') {
      if (!needs(token, 'import', reply)) return;
      if ((body.entries ?? []).length > 200) return reply(413, { error: 'too_many_entries', max: 200 });
      return reply(200, fake.importResponse ?? { data: 'OK', skipped: [] });
    }

    if (method === 'GET' && route === '/me') {
      if (!needs(token, 'read', reply)) return;
      return reply(200, { user_id: 'user-1', self_person_id: 'user-1', email: 'pilot@example.com' });
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

  function proposeChange(body, reply) {
    const errors = [];
    if (!Array.isArray(body.operations) || body.operations.length === 0) {
      errors.push({ index: null, field: 'operations', message: 'must not be empty' });
    }
    for (const [index, operation] of (body.operations ?? []).entries()) {
      if (!['create', 'update', 'delete'].includes(operation.op)) {
        errors.push({ index, field: 'op', message: 'must be one of create, update, delete' });
      }
      if (operation.op !== 'create' && typeof operation.id !== 'string') {
        errors.push({ index, field: 'id', message: 'required for update/delete' });
      }
    }
    if (errors.length) return reply(422, { error: { message: 'Invalid operations', errors } });

    const open = [...changes.values()].filter((change) => change.status === 'pending').length;
    if (open >= fake.openProposalCap) {
      return reply(409, { error: { message: 'Too many open pending changes', code: 'open_cap_reached' } });
    }

    const change = {
      id: randomUUID(),
      status: 'pending',
      client_kind: 'partner',
      client_name: 'Jetlog Sample App',
      summary: body.summary,
      operations: body.operations,
      preview: [],
      counts: { creates: 0, updates: body.operations.length, deletes: 0 },
      error: null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
