// Jetlog's read routes send no signature, attachment or photo fields to an app, and
// a partner never holds the permissions for them. The sample must not read, show or
// ask for any of those fields. This test reads the source for their names, so a
// change that starts using one fails here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const FORBIDDEN = [
  /\bsignature\b/,
  /\bsignature_(attachment_id|sha256|waived)\b/,
  /\battachment_count\b/,
  /\bhas_photo\b/,
  /\bphoto_(attachment_id|sha256)\b/,
];

test('no source file of the sample mentions a signature, attachment or photo field', () => {
  const folder = new URL('../src/', import.meta.url);
  const files = readdirSync(folder).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 5);

  for (const name of files) {
    const text = readFileSync(new URL(name, folder), 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${name} mentions ${pattern}`);
    }
  }
});

test('the fake Jetlog sends none of those fields either, so the tests see what a real app sees', async () => {
  const { makeEntry } = await import('../test-support/fake-jetlog.js');
  const text = JSON.stringify(makeEntry(1, '2026-10-01'));
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
});
