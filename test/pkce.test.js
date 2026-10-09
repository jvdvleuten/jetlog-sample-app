import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodeChallenge, createCodeVerifier, createState } from '../src/pkce.js';

test('the code challenge matches the example in RFC 7636 appendix B', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(createCodeChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('a code verifier uses only the allowed characters and has a valid length', () => {
  const verifier = createCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
});

test('the challenge has no padding and no characters that need escaping', () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.match(createCodeChallenge(createCodeVerifier()), /^[A-Za-z0-9_-]{43}$/);
  }
});

test('every attempt gets a new verifier and a new state', () => {
  assert.notEqual(createCodeVerifier(), createCodeVerifier());
  assert.notEqual(createState(), createState());
  assert.match(createState(), /^[A-Za-z0-9_-]{16,}$/);
});
