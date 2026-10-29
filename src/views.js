// The pages. Plain server rendered HTML, one function per page.

import { html, raw } from './html.js';
import { describeChangeStatus, describeGrant, describeSkip, describeWarning } from './plain-words.js';
import { ACCESS_LEVELS } from './connect.js';
import { LIMITS } from './text-rules.js';
const MAX_REMARKS_LENGTH = LIMITS.remarks;

const STYLE = `
  :root { color-scheme: light dark; --line: #8884; --muted: #777; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2rem; }
  nav a { margin-right: 1rem; }
  section, .box { border: 1px solid var(--line); border-radius: 8px; padding: 0.25rem 1rem 1rem; margin: 1rem 0; }
  .box { padding: 0.75rem 1rem; }
  .ok { border-color: #1a8a3a; } .warn { border-color: #c77700; } .error { border-color: #c0302b; }
  .muted { color: var(--muted); }
  button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }
  input { font: inherit; padding: 0.3rem; }
  label { display: inline-block; margin: 0.25rem 0.75rem 0.25rem 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  code, pre { font-family: ui-monospace, monospace; font-size: 0.9em; }
  pre { overflow-x: auto; padding: 0.5rem; border: 1px solid var(--line); border-radius: 6px; }
  .choice { display: block; margin: 0.5rem 0; }
  form.inline { display: inline; }
`;

export function layout({ title, flash, canRead, body }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${raw(STYLE)}</style>
</head>
<body>
  <h1>Jetlog Sample App</h1>
  <p class="muted">A small example of an app that connects to Jetlog with OAuth.</p>
  <nav>
    <a href="/">Home</a>
    ${canRead ? html`<a href="/logbook">Logbook</a>` : ''}
  </nav>
  ${flash ? flashBox(flash) : ''}
  ${body}
</body>
</html>`;
}

function flashBox({ kind, title, lines = [], items = [] }) {
  return html`<div class="box ${kind}" role="status">
    <strong>${title}</strong>
    ${lines.map((line) => html`<p>${line}</p>`)}
    ${items.length ? html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>` : ''}
  </div>`;
}

const connectForm = (heading) => html`
  <section>
    <h2>${heading}</h2>
    <p>What should this app be allowed to do? The pilot makes the final choice in the Jetlog app and can always pick the lower level. Jetlog also decides per app whether it may ask for the whole logbook. If it may not, the request is quietly narrowed to own flights.</p>
    <form method="post" action="/connect">
      <div class="choice">
        <button name="access" value="own">Connect: ${ACCESS_LEVELS.own.label}</button>
        <span class="muted">Add flights, and change or remove the flights this app added. Asks for the scope <code>${ACCESS_LEVELS.own.scope}</code>.</span>
      </div>
      <div class="choice">
        <button name="access" value="full">Connect: ${ACCESS_LEVELS.full.label}</button>
        <span class="muted">Also read the logbook and propose changes that the pilot approves. Asks for the scopes <code>${ACCESS_LEVELS.full.scope}</code>.</span>
      </div>
    </form>
  </section>`;

const yesNo = (value) => (value ? 'Yes' : 'No');

function connectionSection({ tokens, grant, now }) {
  const minutes = Math.round((tokens.expiresAt - now()) / 60000);
  return html`
  <section>
    <h2>Connected: ${grant.headline}</h2>
    <p>${grant.summary}</p>
    ${grant.downgradeNote ? html`<div class="box warn">${grant.downgradeNote}</div>` : ''}
    <table>
      <tr><th>Add flights</th><td>${yesNo(grant.abilities.import)}</td></tr>
      <tr><th>Read the logbook</th><td>${yesNo(grant.abilities.read)}</td></tr>
      <tr><th>Propose changes</th><td>${yesNo(grant.abilities.propose)}</td></tr>
      <tr><th>Scope asked</th><td><code>${tokens.requestedScope || 'unknown'}</code></td></tr>
      <tr><th>Scope granted</th><td><code>${tokens.scope || 'none'}</code></td></tr>
      <tr><th>Access token</th><td>${minutes > 0 ? `valid for about ${minutes} more minutes` : 'expired, it is refreshed on the next request'}</td></tr>
      <tr><th>Last refresh</th><td>${tokens.refreshedAt ? new Date(tokens.refreshedAt).toISOString() : 'not yet'}</td></tr>
    </table>
    <div>
      <form class="inline" method="post" action="/refresh"><button>Refresh the token now</button></form>
      <form class="inline" method="post" action="/disconnect"><button>Disconnect</button></form>
    </div>
    <p class="muted">The refresh button is only here to show a refresh. The sample refreshes by itself a minute before the token expires, and when Jetlog answers 401.</p>
  </section>`;
}

const importForm = ({ today }) => html`
  <section>
    <h2>Add a flight</h2>
    <p>Sends one flight to <code>POST /api/partner/v1/import</code>. Sending the same flight again matches it instead of adding a second one.</p>
    <form method="post" action="/import">
      <label>Date <input type="date" name="date" value="${today}" required></label>
      <label>Flight number <input name="flightNumber" value="KL1023" size="8" maxlength="${LIMITS.importText}"></label>
      <label>From <input name="from" value="EHAM" size="5" maxlength="${LIMITS.importText}" required></label>
      <label>To <input name="to" value="EGLL" size="5" maxlength="${LIMITS.importText}" required></label>
      <button>Add flight</button>
    </form>
  </section>`;

export function homePage({ tokens, now, today, flash }) {
  if (!tokens) {
    return layout({
      title: 'Jetlog Sample App',
      flash,
      body: html`
        <p>This app is not connected to a Jetlog logbook yet. Pick what it may do, and Jetlog will ask the pilot to approve.</p>
        ${connectForm('Connect to Jetlog')}`,
    });
  }

  const grant = describeGrant({ requested: tokens.requestedScope, granted: tokens.scope });
  return layout({
    title: 'Jetlog Sample App',
    flash,
    canRead: grant.abilities.read,
    body: html`
      ${connectionSection({ tokens, grant, now })}
      ${grant.abilities.import ? importForm({ today }) : ''}
      ${grant.abilities.read
        ? html`<section><h2>Your logbook</h2><p>The scope <code>read</code> was granted. <a href="/logbook">See who is connected and the newest flights.</a></p></section>`
        : ''}`,
  });
}

export function importResultFlash({ skipped, warnings }) {
  if (!skipped.length && !warnings.length) {
    return { kind: 'ok', title: 'Jetlog accepted the flight', lines: ['Nothing was skipped and there were no warnings.'] };
  }
  return {
    kind: 'warn',
    title: 'Jetlog answered OK, but read what it says',
    lines: ['A 200 does not mean every row landed. Check skipped and warnings every time.'],
    items: [...skipped.map(describeSkip), ...warnings.map(describeWarning)],
  };
}

export const flightLabel = (flight) =>
  [flight.derived?.date ?? flight.date, flight.flight_number, `${flight.derived?.from ?? flight.from ?? '?'} to ${flight.derived?.to ?? flight.to ?? '?'}`]
    .filter(Boolean)
    .join(' ');

// A flight this app added can be changed straight away with the import form. For
// any other flight the app can only propose a change, which the pilot approves.
function flightRow(flight, { canPropose }) {
  const label = flightLabel(flight);
  const own = flight.is_own === true;
  return html`<tr>
    <td>${flight.derived?.date ?? flight.date}</td>
    <td>${flight.flight_number}</td>
    <td>${flight.derived?.from ?? flight.from} to ${flight.derived?.to ?? flight.to}</td>
    <td>${own ? 'This app' : 'Not this app'}</td>
    <td>${flight.remarks}</td>
    <td>
      ${own
        ? html`<span class="muted">Added by this app. Change it with the <a href="/">import form</a>, which changes it directly.</span>`
        : canPropose
          ? html`<form method="post" action="/propose">
              <input type="hidden" name="entryId" value="${flight.id}">
              <input type="hidden" name="label" value="${label}">
              <input name="remarks" maxlength="${MAX_REMARKS_LENGTH}" placeholder="New remarks" required>
              <button>Propose a change</button>
            </form>`
          : ''}
    </td>
  </tr>`;
}

export function logbookPage({ pilot, recent, canPropose, flash }) {
  return layout({
    title: 'Logbook, Jetlog Sample App',
    flash,
    canRead: true,
    body: html`
      <section>
        <h2>Who is connected</h2>
        <p>From <code>GET /api/partner/v1/me</code>, which answers with ids only, and the person with that id in <code>GET /api/partner/v1/people</code>.</p>
        <table>
          <tr><th>Name</th><td>${pilot.name ?? 'Not in the people list'}</td></tr>
          <tr><th>Pilot id</th><td><code>${pilot.userId ?? 'not shown'}</code></td></tr>
        </table>
      </section>
      <section>
        <h2>Newest flights</h2>
        <p>From <code>GET /api/partner/v1/entries</code>, newest first. Jetlog sends flights oldest first, so the sample asks for the flights of the last 60 days and shows the end of the list.</p>
        ${recent.incomplete ? html`<div class="box warn">The sample stops after ${recent.loaded} flights, so there may be newer ones.</div>` : ''}
        ${recent.flights.length
          ? html`<table>
              <tr><th>Date</th><th>Flight</th><th>Route</th><th>Added by</th><th>Remarks</th><th>Change</th></tr>
              ${recent.flights.map((flight) => flightRow(flight, { canPropose }))}
            </table>`
          : html`<p>No flights in the last 60 days. Add one on the home page and come back.</p>`}
        <p class="muted">Jetlog marks the flights this app added with <code>is_own</code>. The import form changes those directly. For every other flight the app can only propose a change. A proposal does not change the flight: Jetlog stores it, tells the pilot, and applies it only after the pilot approves it in the Jetlog app.</p>
        ${canPropose ? '' : html`<p class="muted">Proposing changes needs the scope <code>write</code>, which was not granted.</p>`}
      </section>`,
  });
}

export function proposalFlash() {
  return {
    kind: 'ok',
    title: 'Proposal sent. Nothing has changed yet.',
    lines: ['The flight stays as it is until the pilot approves this proposal in the Jetlog app.'],
  };
}

// What the proposal changes, from the preview Jetlog sends: for every item the
// fields in changed_fields, with their value before and after.
function previewSection(preview) {
  const items = (preview ?? []).filter((item) => (item.changed_fields ?? []).length > 0);
  if (!items.length) return '';

  const show = (value) => (value === null || value === undefined || value === '' ? '(empty)' : typeof value === 'object' ? JSON.stringify(value) : value);

  return html`
    <h3>What it changes</h3>
    ${items.map((item) => {
      const label = item.after?.flight_number ?? item.before?.flight_number ?? item.id;
      return html`<table>
        <tr><th colspan="3">${item.op} ${item.resource} ${label}</th></tr>
        <tr><th>Field</th><th>Before</th><th>After</th></tr>
        ${item.changed_fields.map(
          (field) => html`<tr><td><code>${field}</code></td><td>${show(item.before?.[field])}</td><td>${show(item.after?.[field])}</td></tr>`,
        )}
      </table>`;
    })}`;
}

// The operations as sent. Once a proposal is applied, every operation says
// whether it was applied, because the pilot may approve only some of them.
function operationsSection(operations) {
  if (!operations?.length) return '';
  const hasResult = operations.some((operation) => typeof operation.applied === 'boolean');

  return html`
    <h3>Operations</h3>
    <table>
      <tr><th>#</th><th>Operation</th><th>Id</th>${hasResult ? html`<th>Result</th>` : ''}</tr>
      ${operations.map(
        (operation, position) => html`<tr>
          <td>${(operation.index ?? position) + 1}</td>
          <td>${operation.op} ${operation.resource}</td>
          <td><code>${operation.id}</code></td>
          ${hasResult ? html`<td>${operation.applied ? 'Applied' : 'Not applied'}</td>` : ''}
        </tr>`,
      )}
    </table>`;
}

export function changePage({ change, flash }) {
  return layout({
    title: 'Proposal, Jetlog Sample App',
    flash,
    canRead: true,
    body: html`
      <section>
        <h2>Proposal ${change.id}</h2>
        <p>From <code>GET /api/partner/v1/changes/:id</code>.</p>
        <div class="box ${change.status === 'pending' ? 'warn' : 'ok'}">
          <strong>Status: ${change.status}</strong>
          <p>${describeChangeStatus(change.status)}</p>
          ${change.status === 'pending' ? html`<p>Nothing changes until the pilot approves it in the Jetlog app.</p>` : ''}
          ${change.error ? html`<p>Error from Jetlog: ${change.error}</p>` : ''}
        </div>
        <table>
          <tr><th>Summary</th><td>${change.summary}</td></tr>
          <tr><th>Made</th><td>${change.created_at ?? 'unknown'}</td></tr>
          <tr><th>Expires</th><td>${change.expires_at ?? 'unknown'}</td></tr>
          <tr><th>Decided</th><td>${change.decided_at ?? 'not yet'}</td></tr>
          <tr><th>Counts</th><td><code>${JSON.stringify(change.counts ?? {})}</code></td></tr>
        </table>
        ${previewSection(change.preview)}
        ${operationsSection(change.operations)}
        <p><a href="/changes/${encodeURIComponent(change.id)}">Check again</a> or <a href="/logbook">go back to the logbook</a>.</p>
      </section>`,
  });
}

// The status of a proposal could not be read. The page stays here instead of
// sending the pilot elsewhere, so a wait that Jetlog asks for is shown where the
// poll was made.
export function changeUnavailablePage({ id, flash }) {
  return layout({
    title: 'Proposal, Jetlog Sample App',
    flash,
    canRead: true,
    body: html`
      <section>
        <h2>Proposal ${id}</h2>
        <p>The status could not be read right now.</p>
        <p><a href="/changes/${encodeURIComponent(id)}">Check again</a> or <a href="/logbook">go back to the logbook</a>.</p>
      </section>`,
  });
}

export function notFoundPage() {
  return layout({ title: 'Not found', body: html`<p>There is nothing at this address. <a href="/">Go home</a>.</p>` });
}
