// Where the tokens of the one local user are kept: a JSON file next to the code.
//
// This is only fine for a sample. A real app keeps one record per pilot, and keeps
// the refresh token in encrypted storage (the Keychain on iOS, the Keystore on
// Android, or an encrypted column or secret store on a server).

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createTokenStore(file) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // No file yet, or a file we cannot read: the same as not connected.
        return null;
      }
    },

    // Writes the whole record in one step, so a crash never leaves half a file.
    save(tokens) {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
    },

    clear() {
      rmSync(file, { force: true });
    },
  };
}

// Turns a token endpoint response into the record we keep. `expires_in` is in seconds.
// `requestedScope` is what we asked for, kept so the page can tell when we got less.
export function tokensFromResponse(response, { now, requestedScope, previous = {} }) {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: now() + Number(response.expires_in) * 1000,
    scope: typeof response.scope === 'string' ? response.scope : (previous.scope ?? ''),
    requestedScope: requestedScope ?? previous.requestedScope ?? '',
    connectedAt: previous.connectedAt ?? now(),
    refreshedAt: previous.accessToken ? now() : null,
  };
}
