// The three random values of one authorization attempt (RFC 7636, method S256).

import { createHash, randomBytes } from 'node:crypto';

// base64url without padding, which is what PKCE and Jetlog expect.
const base64url = (buffer) => buffer.toString('base64url');

// 32 random bytes give a 43 character verifier, the shortest length RFC 7636 allows.
export function createCodeVerifier() {
  return base64url(randomBytes(32));
}

// The challenge is the SHA-256 hash of the verifier. Only the hash goes through the
// browser, the verifier itself stays on the server until the code exchange.
export function createCodeChallenge(codeVerifier) {
  return base64url(createHash('sha256').update(codeVerifier, 'ascii').digest());
}

// Ties the callback to the attempt that started it.
export function createState() {
  return base64url(randomBytes(16));
}
