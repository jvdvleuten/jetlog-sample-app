// The metadata document that GitHub Pages serves, checked against the rules in the
// Jetlog guide and against the defaults of the sample.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const document = JSON.parse(readFileSync(new URL('../docs/client.json', import.meta.url), 'utf8'));

test('client_id is the URL the document is served from, and the default client ID of the sample', () => {
  assert.equal(document.client_id, 'https://jvdvleuten.github.io/jetlog-sample-app/client.json');
  assert.equal(loadConfig({}).clientId, document.client_id);
});

test('the name and the optional fields follow the rules', () => {
  assert.equal(document.client_name, 'Jetlog Sample App');
  assert.match(document.client_name, /^[\x20-\x7e]{1,64}$/);
  assert.equal(document.client_uri, 'https://github.com/jvdvleuten/jetlog-sample-app');
  assert.ok(document.client_uri.length <= 255);
});

test('the redirect addresses are https or loopback, and include the one the sample uses', () => {
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  for (const uri of document.redirect_uris) {
    const url = new URL(uri);
    assert.ok(uri.length <= 255);
    assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname)), uri);
  }
  assert.deepEqual(document.redirect_uris, ['http://127.0.0.1:8787/callback', 'http://localhost:8787/callback']);
  assert.ok(document.redirect_uris.includes(loadConfig({}).redirectUri));
});

test('the sample document has no jetlog_developer field, because Jetlog registered the sample itself', () => {
  // A developer's own document needs the verification value from the console. The
  // sample is the exception, so nothing here may start to require the field.
  assert.equal('jetlog_developer' in document, false);
});
