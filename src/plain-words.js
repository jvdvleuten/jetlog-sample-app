// Jetlog's codes and scopes, said in plain words for the pilot and for the developer.

const scopesOf = (scope) => new Set(String(scope ?? '').split(/\s+/).filter(Boolean));

function levelOf(scope) {
  const scopes = scopesOf(scope);
  if (scopes.has('import') && scopes.has('read') && scopes.has('write')) return 'full';
  if (scopes.size === 1 && scopes.has('import')) return 'own';
  return 'other';
}

// 3. What was actually granted. `granted` is the `scope` of the token response,
// `requested` is what we asked for. They differ when the pilot picked the lower
// level in the Jetlog app, or when Jetlog does not allow this app to ask for more.
export function describeGrant({ requested, granted }) {
  const scopes = scopesOf(granted);
  const grantedLevel = levelOf(granted);
  const requestedLevel = levelOf(requested);
  const downgraded = requestedLevel === 'full' && grantedLevel !== 'full';

  const abilities = {
    import: scopes.has('import'),
    read: scopes.has('read'),
    propose: scopes.has('write'),
  };

  const headline = {
    own: 'Own flights only',
    full: 'Whole logbook',
    other: `Scopes: ${[...scopes].join(' ') || 'none'}`,
  }[grantedLevel];

  const summary = {
    own: 'This app can add flights to your logbook, and change or remove the flights it added itself. It cannot read your logbook or change anything else.',
    full: 'This app can add flights directly. It can read your whole logbook. It can propose changes to flights it did not add, but nothing changes until you approve the proposal in the Jetlog app.',
    other: 'Jetlog granted a combination of scopes this sample does not describe. The buttons below follow the scopes.',
  }[grantedLevel];

  const downgradeNote = downgraded
    ? 'This app asked for the whole logbook and got less. There are two possible reasons. The pilot chose the lower level in the Jetlog app, or Jetlog has not enabled the whole logbook for this app, in which case Jetlog quietly grants own flights only and reports no error. Reading and proposing are switched off. To ask again, disconnect and connect again. If Jetlog has not enabled the whole logbook for this app, asking again gives the same result.'
    : null;

  return { grantedLevel, requestedLevel, downgraded, headline, summary, downgradeNote, abilities };
}

// The status of a proposal, from GET /changes/:id.
export function describeChangeStatus(status) {
  switch (status) {
    case 'pending':
      return 'Waiting for the pilot. Nothing has changed. The pilot can approve or reject the proposal in the Jetlog app.';
    case 'applied':
      return 'The pilot approved the proposal in the Jetlog app and Jetlog applied it. A pilot can approve only some of the operations, so check which ones were applied below.';
    case 'rejected':
      return 'The pilot rejected the proposal. Nothing changed.';
    case 'expired':
      return 'Nobody decided within 24 hours, so the proposal expired. Nothing changed.';
    case 'stale':
      return 'Something this proposal touches changed after the proposal was made, so Jetlog did not apply it. Nothing was applied. Propose again if you still want the change.';
    case 'failed':
      return 'Applying the proposal failed. Jetlog shows the error below when it has one.';
    case 'revoked':
      return 'The pilot disconnected this app in Jetlog, so its open proposals were revoked. Nothing was applied.';
    default:
      return `Jetlog reported the status "${status}", which this sample does not know.`;
  }
}

// The reasons a row of an import can be left out of the logbook. A 200 does not
// mean every row landed, so these are shown on every import.
const SKIP_REASONS = {
  duplicate: 'The flight already exists from another source (the pilot, a roster import or another partner). Those are never changed by an import.',
  missing_route: 'The row has no from and to. The import needs both.',
  unsupported_type: 'Only flights can be imported. Nothing was stored for this row.',
  duplicate_in_payload: 'The same flight appears more than once in this request. The last one was imported.',
  deleted: 'This app deleted the flight earlier. Send is_deleted: false to restore it.',
  invalid_field: 'A field of the row is not valid, so this row was left out.',
};

export function describeSkip(item) {
  const flight = [item.date, item.flight_number, item.from && item.to ? `${item.from} to ${item.to}` : null]
    .filter(Boolean)
    .join(' ');
  const reason = SKIP_REASONS[item.reason] ?? `Left out for the reason "${item.reason}".`;
  const fields = Array.isArray(item.fields) && item.fields.length ? ` Check: ${item.fields.join(', ')}.` : '';
  return `${flight || 'A row'}: ${reason}${fields}`;
}

export function describeWarning(item) {
  const flight = [item.date, item.flight_number].filter(Boolean).join(' ');
  if (item.reason === 'unresolved_person_ref') {
    return `${flight || 'A flight'}: imported, but the crew member "${item.ref_id}" is not in the people list of this request, so that crew member was left off.`;
  }
  return `${flight || 'A flight'}: ${item.reason}`;
}
