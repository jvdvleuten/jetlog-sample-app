// Jetlog's read routes send an app no signature, attachment or photo fields, no
// entry_source, and none of the flight feed columns (the *_system fields). Jetlog
// says which flights an app added with is_own instead. The sample must not read,
// show or ask for any of the removed fields. This test reads the source for their
// names, so a change that starts using one fails here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const FORBIDDEN = [
  /\bsignature\b/,
  /\bsignature_(attachment_id|sha256|waived)\b/,
  /\battachment_count\b/,
  /\bhas_photo\b/,
  /\bphoto_(attachment_id|sha256)\b/,
  /\bentry_source\b/,
  /\b(registration|off_blocks|airborne|touchdown|on_blocks)_system\b/,
  /\bsystem_(date|from|to)\b/,
];

test('no source file of the sample mentions a signature, attachment, photo, entry_source or feed field', () => {
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

test('the fake Jetlog sends none of those fields either, and does send is_own', async () => {
  const { makeEntry } = await import('../test-support/fake-jetlog.js');
  const entry = makeEntry(1, '2026-10-01');
  const text = JSON.stringify(entry);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
  assert.equal(entry.is_own, false);
});
