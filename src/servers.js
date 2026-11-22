// A qué servidor de MusicBrainz puede apuntar el bot, y qué URLs acepta.
// El servicio no abre cualquier URL: sólo la del form esperado en ese servidor.

export const SERVERS = {
  test: {
    name: 'test',
    mb: 'https://test.musicbrainz.org',
    auth: 'https://test.metabrainz.org',
  },
  production: {
    name: 'production',
    mb: 'https://musicbrainz.org',
    auth: 'https://metabrainz.org',
  },
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const KINDS = {
  event: { path: new RegExp('^/event/create$') },
  event_art: { path: new RegExp(`^/event/(${UUID})/add-event-art$`, 'i') },
};

export class RequestError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function resolveServer(name, config) {
  if (typeof name !== 'string' || !(name in SERVERS)) {
    throw new RequestError('invalid_server', '"server" must be "test" or "production"');
  }
  if (name === 'production' && !config.allowProduction) {
    throw new RequestError(
      'server_not_allowed',
      'production is disabled (set MB_ALLOW_PRODUCTION=true to enable it)',
      403,
    );
  }
  return SERVERS[name];
}

// Devuelve la URL parseada si apunta al form de `kind` en `server`.
export function validateFormUrl(server, kind, rawUrl) {
  const spec = KINDS[kind];
  if (!spec) throw new RequestError('invalid_kind', `unsupported kind "${kind}"`);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RequestError('invalid_url', '"url" is not a valid URL');
  }
  if (url.origin !== server.mb) {
    throw new RequestError('invalid_url', `"url" must be on ${server.mb}`);
  }
  const match = spec.path.exec(url.pathname);
  if (!match) {
    throw new RequestError('invalid_url', `"url" is not the ${kind} form`);
  }
  return { url, entityMbid: match[1]?.toLowerCase() ?? null };
}
