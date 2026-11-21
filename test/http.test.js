import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Captures } from '../src/captures.js';
import { createHttpServer } from '../src/http.js';
import { BotService } from '../src/service.js';
import { RequestError } from '../src/servers.js';
import { PNG, silentLog, testConfig } from './helpers/setup.js';

const TOKEN = 'service-token';
let server;
let base;
let captures;
const calls = [];
const stub = {
  health: () => ({ status: 'ok' }),
  account: async (server) => {
    calls.push(['account', server]);
    return { logged_in: true };
  },
  createEdit: async (body) => {
    calls.push(['createEdit', body]);
    if (body.kind === 'busy') throw new RequestError('busy', 'busy', 409);
    if (body.kind === 'boom') throw new Error(`boom with ${TOKEN}`);
    return { status: 'created', mbid: 'abc' };
  },
};

before(async () => {
  const config = testConfig();
  captures = new Captures(config.dataDir, 1);
  await captures.init();
  fs.writeFileSync(path.join(captures.dir, '11111111-1111-4111-8111-111111111111-before.png'), PNG);
  server = createHttpServer({ service: stub, captures, config, log: silentLog });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const call = (method, url, { token = TOKEN, body } = {}) =>
  fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body,
  });

describe('authentication', () => {
  it('serves /health without a token (for container health checks) and nothing else', async () => {
    assert.equal((await call('GET', '/health', { token: null })).status, 200);
    for (const [method, url] of [['GET', '/account'], ['POST', '/edits'], ['GET', '/captures/x']]) {
      const res = await call(method, url, { token: null, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
  });

  it('rejects wrong tokens, including one with the same length and a prefix of the real one', async () => {
    for (const token of ['wrong', 'service-tokeX', 'service-toke', 'service-token2']) {
      assert.equal((await call('GET', '/account', { token })).status, 401, token);
    }
    assert.equal((await fetch(`${base}/account`, { headers: { authorization: `Basic ${TOKEN}` } })).status, 401);
  });
});

describe('routes', () => {
  it('POST /edits hands the JSON body to the service and returns its result', async () => {
    const res = await call('POST', '/edits', { body: JSON.stringify({ kind: 'event', url: 'u', server: 'test' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'created', mbid: 'abc' });
    assert.deepEqual(calls.at(-1), ['createEdit', { kind: 'event', url: 'u', server: 'test' }]);
  });

  it('GET /account defaults to the test server and passes ?server= through', async () => {
    await call('GET', '/account');
    assert.deepEqual(calls.at(-1), ['account', 'test']);
    await call('GET', '/account?server=production');
    assert.deepEqual(calls.at(-1), ['account', 'production']);
  });

  it('maps request errors to their HTTP status and hides unexpected errors', async () => {
    const busy = await call('POST', '/edits', { body: JSON.stringify({ kind: 'busy' }) });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, 'busy');

    const boom = await call('POST', '/edits', { body: JSON.stringify({ kind: 'boom' }) });
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: { code: 'internal_error', message: 'unexpected error' } });
  });

  it('rejects bodies that are not JSON or are too large', async () => {
    assert.equal((await call('POST', '/edits', { body: '{nope' })).status, 400);
    assert.equal((await call('POST', '/edits', { body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) })).status, 413);
  });

  it('serves captures by id only, never by path', async () => {
    const ok = await call('GET', '/captures/11111111-1111-4111-8111-111111111111-before');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '11111111-1111-4111-8111-111111111111-before.png', 'nope']) {
      assert.equal((await call('GET', `/captures/${id}`)).status, 404, id);
    }
  });

  it('answers 404 to anything else', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('DELETE', '/edits')).status, 404);
  });
});

describe('request validation in the service (no browser is started)', () => {
  const service = new BotService({ config: testConfig(), log: silentLog, captures });
  const unconfigured = new BotService({
    config: testConfig({ MB_BOT_USERNAME: '', MB_BOT_PASSWORD: '' }),
    log: silentLog,
    captures,
  });
  const ok = { kind: 'event', server: 'test', url: 'https://test.musicbrainz.org/event/create?edit-event.name=x' };
  const rejects = (svc, body, code, httpStatus) => assert.rejects(svc.createEdit(body), { code, httpStatus });

  it('rejects malformed requests with 400', async () => {
    await rejects(service, null, 'invalid_body', 400);
    await rejects(service, { ...ok, kind: 'delete_everything' }, 'invalid_kind', 400);
    await rejects(service, { ...ok, server: undefined }, 'invalid_server', 400);
    await rejects(service, { ...ok, server: 'staging' }, 'invalid_server', 400);
    await rejects(service, { ...ok, url: 'not a url' }, 'invalid_url', 400);
    await rejects(service, { ...ok, kind: 'event_art', url: 'https://test.musicbrainz.org/event/11111111-1111-4111-8111-111111111111/add-event-art' }, 'invalid_image_url', 400);
  });

  it('never opens a URL outside the expected form on the expected server', async () => {
    for (const url of [
      'https://musicbrainz.org/event/create',
      'https://test.musicbrainz.org.evil.example/event/create',
      'http://test.musicbrainz.org/event/create',
      'https://test.musicbrainz.org/event/create/extra',
      'https://test.musicbrainz.org/place/create',
      'https://test.musicbrainz.org/event/11111111-1111-4111-8111-111111111111/edit',
      'file:///etc/passwd',
    ]) {
      await rejects(service, { ...ok, url }, 'invalid_url', 400);
    }
  });

  it('keeps production off unless MB_ALLOW_PRODUCTION=true, for /edits and /account', async () => {
    await rejects(service, { ...ok, server: 'production', url: 'https://musicbrainz.org/event/create' }, 'server_not_allowed', 403);
    await assert.rejects(service.account('production'), { code: 'server_not_allowed', httpStatus: 403 });
  });

  it('answers 501 for place and artist (Story #4) and 503 without credentials', async () => {
    await rejects(service, { ...ok, kind: 'place' }, 'not_implemented', 501);
    await rejects(service, { ...ok, kind: 'artist' }, 'not_implemented', 501);
    await rejects(unconfigured, ok, 'not_configured', 503);
    await assert.rejects(unconfigured.account('test'), { code: 'not_configured', httpStatus: 503 });
  });
});
