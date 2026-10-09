// Everything that can go wrong, as small error classes, plus explainError() which
// turns any of them into plain words for the page. Nothing here is hidden: the
// pilot or the developer always sees what happened and what to do next.

export class NotConnectedError extends Error {
  constructor() {
    super('Not connected');
  }
}

// Jetlog ended the connection (refresh answered invalid_grant). The tokens are gone.
export class DisconnectedError extends Error {
  constructor() {
    super('The connection with Jetlog ended');
  }
}

// Jetlog switched off this app's registration (refresh answered unauthorized_client).
// The tokens are kept, because they work again once the registration is enabled.
export class RegistrationDisabledError extends Error {
  constructor() {
    super('The registration of this app is disabled');
  }
}

export class NetworkError extends Error {
  constructor(url, cause) {
    super(`Could not reach ${url}`);
    this.cause = cause;
  }
}

// A non-2xx answer from Jetlog. The import route answers {"error":"some_code"},
// the proposal routes nest the error as {"error":{"message","code","errors"}}.
// Both are read here so the rest of the sample does not care.
export class JetlogApiError extends Error {
  constructor({ status, code, message, retryAfter = null, fieldErrors = [], missingScopes = [], body = null }) {
    super(message || code || `Jetlog answered ${status}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.fieldErrors = fieldErrors;
    this.missingScopes = missingScopes;
    this.body = body;
  }

  static fromResult({ status, body, retryAfter }) {
    const error = body?.error;
    const nested = error !== null && typeof error === 'object';
    return new JetlogApiError({
      status,
      code: nested ? error.code : typeof error === 'string' ? error : undefined,
      message: nested ? error.message : body?.message,
      retryAfter,
      fieldErrors: nested && Array.isArray(error.errors) ? error.errors : [],
      missingScopes: Array.isArray(body?.missing_scopes) ? body.missing_scopes : [],
      body,
    });
  }
}

const SUPPORT = 'support@jetlog.app';

export function explainError(err, { context } = {}) {
  if (err instanceof NotConnectedError) {
    return { title: 'Not connected', lines: ['Connect to Jetlog first.'] };
  }
  if (err instanceof DisconnectedError) {
    return {
      title: 'The connection with Jetlog ended',
      lines: [
        'Jetlog no longer accepts the stored tokens. The pilot may have removed this app in Jetlog, signed out everywhere, or not used the app for 90 days.',
        'The stored tokens were deleted. Connect again to continue.',
      ],
    };
  }
  if (err instanceof RegistrationDisabledError) {
    return {
      title: 'Jetlog has switched this app off',
      lines: [
        'Jetlog answered that the registration of this app is disabled.',
        `The stored tokens are kept, because they work again when the registration is enabled. Stop sending requests and email ${SUPPORT}.`,
      ],
    };
  }
  if (err instanceof NetworkError) {
    return {
      title: 'Jetlog could not be reached',
      lines: [`${err.message}. Check your connection and try again.`],
    };
  }
  if (err instanceof JetlogApiError) return explainApiError(err, context);
  return { title: 'Something went wrong', lines: [err?.message ?? String(err)] };
}

function explainApiError(err, context) {
  const { status, code } = err;

  if (status === 401) {
    return {
      title: 'Jetlog does not accept the access token',
      lines: [
        'The token was refreshed once and the request was repeated once, and Jetlog still answered 401.',
        'Disconnect and connect again.',
      ],
    };
  }

  // A proposal that touches files, photos, signatures or signing links is refused
  // for every connected app. The body names what is missing.
  if (status === 403 && code === 'insufficient_scope' && err.missingScopes.length > 0) {
    const refused = [
      err.missingScopes.includes('files') ? 'files and photos' : null,
      err.missingScopes.includes('signatures') ? 'signatures and signing links' : null,
    ].filter(Boolean);
    return {
      title: 'Connected apps cannot change that',
      lines: [
        `A proposal may not touch ${refused.join(' or ') || err.missingScopes.join(' or ')}. Jetlog refuses this for every connected app, whatever the pilot would approve. Nothing was changed.`,
        'Remove those operations and propose the rest.',
      ],
    };
  }
  if (status === 403 && code === 'insufficient_scope') {
    return {
      title: 'This connection does not allow that',
      lines: [
        'The token does not carry the scope this request needs. The pilot may have chosen own flights only in the Jetlog app.',
        'Disconnect, connect again and choose the whole logbook.',
      ],
    };
  }
  if (status === 403 && code === 'insufficient_access') {
    return {
      title: 'Jetlog no longer lets this app do that',
      lines: [
        'Jetlog has switched off reading the logbook and proposing changes for this app. Importing your own flights keeps working.',
        `Email ${SUPPORT} if you expected to have this access.`,
      ],
    };
  }
  if (status === 403 && code === 'integration_disabled') {
    return {
      title: 'Jetlog has switched this app off',
      lines: [
        'The registration of this app is disabled, so Jetlog refuses its requests.',
        `Stop sending. The stored tokens are kept. Email ${SUPPORT}.`,
      ],
    };
  }
  if (status === 403) {
    return { title: 'Jetlog refused the request', lines: [`Jetlog answered 403 (${code ?? 'no code'}).`] };
  }

  if (status === 413) {
    // A body that is too big for the route: { error: "payload_too_large", max_bytes }.
    if (code === 'payload_too_large') {
      return {
        title: 'The request body is too big',
        lines: [`Jetlog accepts at most ${formatBytes(err.body?.max_bytes)} in one request to this route. Nothing was written.`, 'Split it into smaller requests.'],
      };
    }
    // A proposal with too many operations sends a nested error whose message
    // already carries the count, such as "Too many operations (201)".
    if (typeof err.body?.error === 'object') {
      return {
        title: 'The proposal is too big',
        lines: [`${err.message}. A proposal holds at most 200 operations. Nothing was written.`, 'Split it into smaller proposals.'],
      };
    }
    // The import route sends { error, max } for too many entries or people.
    const max = err.body?.max;
    return {
      title: 'The request is too big',
      lines: [
        `Jetlog accepts at most ${max ?? 'a fixed number of'} ${code === 'too_many_people' ? 'people' : 'entries'} in one request. Nothing was written.`,
        'Split the payload into smaller requests.',
      ],
    };
  }

  if (status === 429) {
    const wait = err.retryAfter;
    return {
      title: 'Too many requests',
      lines: [
        wait === null
          ? 'Jetlog asked to slow down. Wait a little, then send the same request again.'
          : `Jetlog asked to wait ${wait} seconds (the Retry-After header). Then send the same request again.`,
      ],
    };
  }

  if (status === 404) {
    return { title: 'Not found', lines: ['Jetlog does not know that item for this pilot.'] };
  }

  if (status === 409 && code === 'open_cap_reached') {
    return {
      title: 'Too many open proposals',
      lines: ['This connection already has 5 open proposals. They have to be approved, rejected or expire first.'],
    };
  }

  // Jetlog names the operation and says in its own plain words what is not
  // allowed, for example "connected apps cannot propose manual_times". Show that.
  if (status === 422) {
    const lines = err.fieldErrors.length
      ? err.fieldErrors.map(describeFieldError)
      : [err.message];
    return { title: 'Jetlog rejected the proposal', lines: [...lines, 'Nothing was written.'] };
  }

  if (status >= 500) {
    const lines = ['Jetlog had a problem on its side. Try again in a moment.'];
    if (context === 'import') lines.push('Sending the same flight again is safe, because Jetlog matches it instead of duplicating it.');
    return { title: `Jetlog answered ${status}`, lines };
  }

  const detail = err.body?.errors?.detail;
  const lines = [code ? `The error code is ${code}.` : detail ? `Jetlog says: ${detail}.` : 'Jetlog sent no error code.'];
  if (status === 400) {
    lines.push('Fix the request and send it again.');
    if (context === 'import') lines.push('Sending a payload again is safe, because Jetlog matches flights instead of duplicating them.');
  }
  return { title: `Jetlog answered ${status}`, lines };
}

// "Operation 1: <Jetlog's message>". Jetlog numbers operations from 0, the page numbers them from 1.
function describeFieldError({ index, field, message }) {
  const where = typeof index === 'number' ? `Operation ${index + 1}: ` : field ? `${field}: ` : '';
  return `${where}${message}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'a fixed number of bytes';
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}
