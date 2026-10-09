// The web part: it turns browser requests into calls to the modules that talk to
// Jetlog, and puts the answers on a page. Nothing here is specific to Jetlog.

import { handleCallback, startConnect, createPendingAuthorizations } from './connect.js';
import { explainError } from './errors.js';
import { buildImportPayload, buildRemarksProposal, createJetlogApi, MAX_REMARKS_LENGTH } from './jetlog-api.js';
import { describeGrant } from './plain-words.js';
import { createTokenManager } from './token-manager.js';
import {
  changePage,
  changeUnavailablePage,
  homePage,
  importResultFlash,
  logbookPage,
  notFoundPage,
  proposalFlash,
} from './views.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ config, store, now = Date.now }) {
  const tokens = createTokenManager({ config, store, now });
  const api = createJetlogApi({ config, tokens, now });
  const pending = createPendingAuthorizations({ now });

  // One local user, so one message waiting to be shown on the next page.
  let flash = null;
  const takeFlash = () => {
    const current = flash;
    flash = null;
    return current;
  };
  const errorFlash = (err, context) => ({ kind: 'error', ...explainError(err, { context }) });

  const today = () => new Date(now()).toISOString().slice(0, 10);

  // ---- pages and actions ----

  function showHome(req, res) {
    sendHtml(res, homePage({ tokens: store.load(), now, today: today(), flash: takeFlash() }));
  }

  // 1. Connect: the pilot picked a level, send them to Jetlog.
  function connect(req, res, form) {
    if (!['own', 'full'].includes(form.access)) throw new HttpError(400, 'Unknown access level');
    redirect(res, startConnect({ access: form.access, config, pending }));
  }

  // 2. Callback: Jetlog sends the pilot back here.
  async function callback(req, res, form, url) {
    let outcome;
    try {
      outcome = await handleCallback({
        query: Object.fromEntries(url.searchParams),
        config,
        pending,
        store,
        now,
      });
    } catch (err) {
      // Jetlog could not be reached while exchanging the code.
      flash = errorFlash(err);
      redirect(res, '/');
      return;
    }

    if (!outcome.ok) {
      flash = { kind: 'error', title: outcome.title, lines: outcome.lines };
    } else {
      // 3. Show what was actually granted.
      const grant = describeGrant({ requested: outcome.tokens.requestedScope, granted: outcome.tokens.scope });
      flash = grant.downgraded
        ? { kind: 'warn', title: 'Connected, with less access than asked for', lines: [grant.downgradeNote] }
        : { kind: 'ok', title: 'Connected', lines: ['The pilot approved this app in Jetlog. What it may do is described below.'] };
    }
    // Redirect so the code in the address bar does not stay in the browser history.
    redirect(res, '/');
  }

  // 4. Import one flight.
  async function importFlight(req, res, form) {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date ?? '')) {
        throw new HttpError(400, 'The date has to look like 2026-08-14.');
      }
      const result = await api.importFlights(buildImportPayload(form));
      flash = importResultFlash(result);
    } catch (err) {
      flash = err instanceof HttpError ? { kind: 'error', title: err.message } : errorFlash(err, 'import');
    }
    redirect(res, '/');
  }

  // 5. Who is connected, and the newest flights.
  async function showLogbook(req, res) {
    try {
      const [pilot, recent] = await Promise.all([api.getPilot(), api.listRecentFlights()]);
      const grant = describeGrant({ requested: '', granted: store.load()?.scope });
      sendHtml(res, logbookPage({ pilot, recent, canPropose: grant.abilities.propose, flash: takeFlash() }));
    } catch (err) {
      flash = errorFlash(err);
      redirect(res, '/');
    }
  }

  // 6. Propose a change, then look at its status.
  async function proposeChange(req, res, form) {
    try {
      const remarks = (form.remarks ?? '').trim();
      if (!form.entryId || !remarks || remarks.length > MAX_REMARKS_LENGTH) {
        throw new HttpError(400, `Remarks must have between 1 and ${MAX_REMARKS_LENGTH} characters.`);
      }
      const change = await api.proposeChanges(
        buildRemarksProposal({ entryId: form.entryId, label: form.label || 'a flight', remarks }),
      );
      flash = proposalFlash();
      redirect(res, `/changes/${encodeURIComponent(change.id)}`);
    } catch (err) {
      flash = err instanceof HttpError ? { kind: 'error', title: err.message } : errorFlash(err);
      // When Jetlog ended the connection (for example the pilot removed the app a
      // moment ago), the tokens are gone and the pilot goes home to connect again.
      redirect(res, store.load() ? '/logbook' : '/');
    }
  }

  async function showChange(req, res, form, url, id) {
    try {
      const change = await api.getChange(id);
      sendHtml(res, changePage({ change, flash: takeFlash() }));
    } catch (err) {
      flash = errorFlash(err);
      if (!store.load()) {
        redirect(res, '/');
        return;
      }
      // Stay on the proposal. This page does not refresh by itself, so a 429 from the
      // status poll is shown with its wait, and the pilot decides when to check again.
      sendHtml(res, changeUnavailablePage({ id, flash: takeFlash() }));
    }
  }

  // Refreshing is automatic. This button only exists so you can watch it happen.
  async function refreshNow(req, res) {
    try {
      await tokens.refreshTokens(store.load()?.accessToken);
      flash = {
        kind: 'ok',
        title: 'The tokens were refreshed',
        lines: ['Jetlog sent a new access token and a new refresh token. The sample stored the new refresh token first. The old one no longer works.'],
      };
    } catch (err) {
      flash = errorFlash(err);
    }
    redirect(res, '/');
  }

  // 8. Disconnect.
  async function disconnect(req, res) {
    const outcome = await tokens.disconnect();
    flash = outcome.revoked
      ? { kind: 'ok', title: 'Disconnected', lines: ['Jetlog revoked the refresh token, and the stored tokens are deleted.'] }
      : {
          kind: 'warn',
          title: 'The stored tokens are deleted, but Jetlog did not confirm the revoke',
          lines: [`Reason: ${outcome.reason}.`, 'The pilot can remove this app under Settings > Connected Apps in the Jetlog app.'],
        };
    redirect(res, '/');
  }

  const routes = new Map([
    ['GET /', showHome],
    ['POST /connect', connect],
    ['GET /callback', callback],
    ['POST /import', importFlight],
    ['GET /logbook', showLogbook],
    ['POST /propose', proposeChange],
    ['POST /refresh', refreshNow],
    ['POST /disconnect', disconnect],
  ]);

  // ---- plumbing ----

  async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (!isLocalRequest(req, config)) throw new HttpError(403, 'This sample only answers requests from its own pages.');

      const changeMatch = req.method === 'GET' ? url.pathname.match(/^\/changes\/([^/]+)$/) : null;
      const route = changeMatch ? showChange : routes.get(`${req.method} ${url.pathname}`);

      if (!route) {
        sendHtml(res, notFoundPage(), 404);
        return;
      }
      const form = req.method === 'POST' ? await readForm(req) : {};
      await route(req, res, form, url, changeMatch ? decodeURIComponent(changeMatch[1]) : undefined);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err.message);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(status === 500 ? 'Something went wrong in the sample app.' : err.message);
    }
  }

  return { handle, tokens, api, pending };
}

// Only requests from the pilot's own browser on this machine. A page on another
// site must not be able to press our Disconnect button (the Host check also stops
// DNS rebinding).
function isLocalRequest(req, config) {
  const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  if (!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return req.method !== 'POST' || origin === undefined || hosts.some((host) => origin === `http://${host}`);
}

async function readForm(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'The request is too big.');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function sendHtml(res, page, status = 200) {
  res.writeHead(status, SECURITY_HEADERS);
  res.end(String(page));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}
