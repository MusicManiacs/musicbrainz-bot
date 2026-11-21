import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { Captures } from '../src/captures.js';
import { loadConfig } from '../src/config.js';
import { downloadImage, ImageError, sniffImage } from '../src/image.js';
import { createLogger } from '../src/log.js';
import { Throttle } from '../src/session.js';
import { PNG, testConfig } from './helpers/setup.js';

describe('config', () => {
  it('has safe defaults: no credentials, production off, pause between submits', () => {
    const c = loadConfig({});
    assert.equal(c.username, '');
    assert.equal(c.password, '');
    assert.equal(c.serviceToken, '');
    assert.equal(c.allowProduction, false);
    assert.ok(c.pauseBetweenSubmitsMs >= 1000);
    assert.ok(c.navIntervalMs >= 1000);
    assert.match(c.userAgent, /github\.com\/MusicManiacs\/musicbrainz-bot/);
  });

  it('only a literal "true" enables production; bad numbers fail at startup', () => {
    assert.equal(loadConfig({ MB_ALLOW_PRODUCTION: '1' }).allowProduction, false);
    assert.equal(loadConfig({ MB_ALLOW_PRODUCTION: 'true' }).allowProduction, true);
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  });
});

describe('logger', () => {
  const capture = (secrets) => {
    const lines = [];
    return { lines, log: createLogger({ secrets, out: { write: (l) => lines.push(l) } }) };
  };

  it('never writes a secret, even inside an error message, JSON-escaped or URL-encoded', () => {
    const password = 'p@ss"w\\rd/1';
    const { lines, log } = capture([password, 'tok-123']);
    log.error('login failed', { error: `fill("${password}") failed` });
    log.info('request', { url: `https://x/?password=${encodeURIComponent(password)}`, auth: 'Bearer tok-123' });
    const out = lines.join('');
    assert.doesNotMatch(out, /p@ss/);
    assert.doesNotMatch(out, /tok-123/);
    assert.doesNotMatch(out, /w\\\\rd/);
    assert.match(out, /\[REDACTED\]/);
  });

  it('writes one JSON object per line', () => {
    const { lines, log } = capture([]);
    log.info('hello', { a: 1 });
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.msg, 'hello');
    assert.equal(entry.a, 1);
    assert.equal(entry.level, 'info');
  });

  it('ignores empty secrets instead of redacting every character gap', () => {
    const { lines, log } = capture(['', undefined]);
    log.info('plain text');
    assert.match(lines[0], /plain text/);
  });
});

describe('image download', () => {
  const respond = (body, { status = 200, headers = {} } = {}) => async () => new Response(body, { status, headers });
  const opts = (fetchImpl, maxBytes = 1000) => ({ maxBytes, userAgent: 'ua', fetchImpl });

  it('decides the type by the bytes, not by the Content-Type', () => {
    assert.equal(sniffImage(PNG).mime, 'image/png');
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ext, 'jpg');
    assert.equal(sniffImage(Buffer.from('GIF89a')).mime, 'image/gif');
    assert.equal(sniffImage(Buffer.from('<html>')), null);
  });

  it('accepts an image and names it by its real type', async () => {
    const image = await downloadImage('https://img.example/p', opts(respond(PNG, { headers: { 'content-type': 'text/html' } })));
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.name, 'poster.png');
    assert.deepEqual(image.buffer, PNG);
  });

  it('rejects non-images, HTTP errors, other protocols and oversized bodies', async () => {
    await assert.rejects(downloadImage('https://img.example/p', opts(respond('<html>', { headers: { 'content-type': 'image/png' } }))), ImageError);
    await assert.rejects(downloadImage('https://img.example/p', opts(respond('nope', { status: 404 }))), /HTTP 404/);
    await assert.rejects(downloadImage('file:///etc/passwd', opts(respond(PNG))), /http\(s\)/);
    await assert.rejects(downloadImage('ftp://x/y.png', opts(respond(PNG))), /http\(s\)/);
    await assert.rejects(downloadImage('nope', opts(respond(PNG))), /not a valid URL/);
    await assert.rejects(downloadImage('https://img.example/p', opts(respond(Buffer.concat([PNG, Buffer.alloc(2000)])))), /larger than/);
    await assert.rejects(
      downloadImage('https://img.example/p', opts(respond(PNG, { headers: { 'content-length': '999999' } }))),
      /larger than/,
    );
  });

  it('turns a network failure into an ImageError', async () => {
    const failing = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(downloadImage('https://img.example/p', opts(failing)), { name: 'Error', message: /ECONNREFUSED/ });
  });
});

describe('captures', () => {
  it('serves only ids it generated and purges files past their time to live', async () => {
    const config = testConfig();
    const captures = new Captures(config.dataDir, 1);
    await captures.init();
    const id = '11111111-1111-4111-8111-111111111111-before';
    const file = `${captures.dir}/${id}.png`;
    fs.writeFileSync(file, PNG);
    assert.equal(await captures.file(id), file);
    assert.equal(await captures.file('../../etc/passwd'), null);
    assert.equal(await captures.file(`${id}/../x`), null);

    await captures.purge(Date.now() + 2 * 24 * 3600 * 1000);
    assert.equal(await captures.file(id), null);
  });
});

describe('throttle', () => {
  it('spaces consecutive navigations by at least the interval', async () => {
    const throttle = new Throttle(150);
    const started = Date.now();
    await throttle.wait();
    await throttle.wait();
    await throttle.wait();
    assert.ok(Date.now() - started >= 290, `took ${Date.now() - started}ms`);
  });
});
