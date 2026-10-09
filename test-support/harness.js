// What most tests need: a fake Jetlog, a token file in a temporary folder, a clock
// the test can move, and the sample's own modules wired to them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPendingAuthorizations, handleCallback, startConnect } from '../src/connect.js';
import { createJetlogApi } from '../src/jetlog-api.js';
import { createTokenManager } from '../src/token-manager.js';
import { createTokenStore } from '../src/token-store.js';
import { startFakeJetlog } from './fake-jetlog.js';

export async function setup({ port = '8787' } = {}) {
  const fake = await startFakeJetlog();
  const folder = mkdtempSync(join(tmpdir(), 'jetlog-sample-'));
  const file = join(folder, 'tokens.json');
  const store = createTokenStore(file);

  let time = Date.UTC(2026, 9, 9, 12, 0, 0);
  const now = () => time;
  const advance = (milliseconds) => {
    time += milliseconds;
  };

  const config = loadConfig({
    JETLOG_BASE_URL: fake.url,
    JETLOG_CLIENT_ID: 'https://app.example/client.json',
    PORT: port,
  });
  const pending = createPendingAuthorizations({ now });
  const tokens = createTokenManager({ config, store, now });
  const api = createJetlogApi({ config, tokens, now });

  // The whole connect flow, with the Jetlog sign-in page played by the fake.
  async function connect(access = 'full', { grant } = {}) {
    const authorizeUrl = startConnect({ access, config, pending });
    const callback = fake.approve(authorizeUrl, { scope: grant });
    const outcome = await handleCallback({
      query: Object.fromEntries(new URL(callback).searchParams),
      config,
      pending,
      store,
      now,
    });
    if (!outcome.ok) throw new Error(`connect failed: ${outcome.title}`);
    return outcome;
  }

  async function cleanup() {
    await fake.close();
    rmSync(folder, { recursive: true, force: true });
  }

  return { fake, config, store, file, pending, tokens, api, now, advance, connect, cleanup };
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
