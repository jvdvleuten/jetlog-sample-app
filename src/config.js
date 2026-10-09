// Settings come from environment variables. The defaults let you run the sample
// against production Jetlog without setting anything.

const DEFAULT_BASE_URL = 'https://jetlog.app';
const DEFAULT_CLIENT_ID = 'https://jvdvleuten.github.io/jetlog-sample-app/client.json';
const DEFAULT_PORT = 8787;

export function loadConfig(env = process.env) {
  const baseUrl = (env.JETLOG_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const clientId = env.JETLOG_CLIENT_ID || DEFAULT_CLIENT_ID;
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number between 0 and 65535, got "${env.PORT}"`);
  }

  return {
    baseUrl,
    clientId,
    port,
    // The redirect URI has to be one of the redirect_uris in the metadata document,
    // character for character. It uses 127.0.0.1 because the sample listens there.
    redirectUri: `http://127.0.0.1:${port}/callback`,
    // The address of the token route. It is also the "resource" a token is issued for.
    partnerApiUrl: `${baseUrl}/api/partner/v1`,
  };
}
