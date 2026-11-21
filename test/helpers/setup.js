import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { Captures } from '../../src/captures.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { BotService } from '../../src/service.js';
import { LINK_TYPES, MB } from './fake-mb.js';

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const ARTIST_A = '11111111-1111-4111-8111-111111111111';
export const ARTIST_B = '22222222-2222-4222-8222-222222222222';
export const PLACE = '33333333-3333-4333-8333-333333333333';
export const SOURCE = 'https://tickets.example.com/fiesta-x';

export function testConfig(env = {}) {
  return loadConfig({
    BOT_SERVICE_TOKEN: 'service-token',
    MB_BOT_USERNAME: 'MusicManiacs_bot',
    MB_BOT_PASSWORD: 'correct horse',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mbbot-')),
    PAUSE_BETWEEN_SUBMITS_MS: '0',
    NAV_INTERVAL_MS: '0',
    LOGIN_TIMEOUT_MS: '1500',
    SUBMIT_TIMEOUT_MS: '2500',
    NAVIGATION_TIMEOUT_MS: '5000',
    ...env,
  });
}

export const silentLog = createLogger({ out: { write() {} } });

// Servicio real (Chromium real) cuyas sesiones hablan con el MusicBrainz falso.
export async function makeService(fake, env = {}, options = {}) {
  const config = testConfig(env);
  const captures = new Captures(config.dataDir, 1);
  await captures.init();
  const { args, contextOptions } = await fake.start();
  const real = await chromium.launch({ args });
  const browser = {
    newContext: (options) => real.newContext({ ...options, ...contextOptions }),
    close: () => real.close(),
  };
  const service = new BotService({ config, log: silentLog, captures, launch: async () => browser, ...options });
  return {
    service,
    captures,
    config,
    close: async () => {
      await service.close();
      await real.close().catch(() => {});
      await fake.stop();
    },
  };
}

export function eventUrl({
  name = 'Fiesta X',
  note = `Sources: ${SOURCE}`,
  rels = [
    [LINK_TYPES.mainPerformer, ARTIST_A],
    [LINK_TYPES.mainPerformer, ARTIST_B],
    [LINK_TYPES.heldAt, PLACE],
  ],
  urls = [SOURCE],
  extra = {},
} = {}) {
  const q = new URLSearchParams();
  q.set('edit-event.name', name);
  q.set('edit-event.type_id', '1');
  q.set('edit-event.period.begin_date.year', '2026');
  q.set('edit-event.period.begin_date.month', '12');
  q.set('edit-event.period.begin_date.day', '14');
  q.set('edit-event.time', '22:00');
  q.set('edit-event.edit_note', note);
  rels.forEach(([type, target], i) => {
    q.set(`rels.${i}.type`, type);
    q.set(`rels.${i}.target`, target);
  });
  urls.forEach((url, i) => {
    q.set(`edit-event.url.${i}.text`, url);
    q.set(`edit-event.url.${i}.link_type_id`, '1');
  });
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${MB}/event/create?${q}`;
}

export function artUrl(mbid, note = `Poster from ${SOURCE}`) {
  return `${MB}/event/${mbid}/add-event-art?${new URLSearchParams({ 'add-event-art.edit_note': note })}`;
}

// Servidor local de imágenes para image_url.
export async function imageServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/poster.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    if (req.url === '/lying.png') return res.writeHead(200, { 'content-type': 'image/png' }).end('<html>not an image</html>');
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}
