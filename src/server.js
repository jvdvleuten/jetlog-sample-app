// Starts the sample: node src/server.js (or npm start).

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createTokenStore } from './token-store.js';

const config = loadConfig();
const store = createTokenStore(fileURLToPath(new URL('../tokens.json', import.meta.url)));
const app = createApp({ config, store });

// Listens on 127.0.0.1 only: the sample holds a pilot's tokens and must not be
// reachable from other machines.
createServer(app.handle).listen(config.port, '127.0.0.1', () => {
  console.log(`Jetlog Sample App: http://127.0.0.1:${config.port}`);
  console.log(`Talking to ${config.baseUrl} as ${config.clientId}`);
});
