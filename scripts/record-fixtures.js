// Vuelve a grabar las páginas PÚBLICAS de test/fixtures/recorded (sólo lecturas, a
// un ritmo lento por el límite de MusicBrainz). No necesita cuenta ni deja cookies.
//
//   npm run record-fixtures
//
// Las páginas que sólo se ven con sesión (form de crear evento, form de arte, listas
// de ediciones con el editor visible) no se pueden grabar sin la cuenta del bot: están
// reconstruidas en test/helpers/fake-mb.js.
import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const out = path.resolve('test/fixtures/recorded');
// MusicBrainz embeds public client keys (Mapbox, Sentry) in every page. They are not needed by
// the tests and secret scanners flag them, so they are redacted before saving.
const sanitize = (html) =>
  html
    .replace(/pk\.eyJ[A-Za-z0-9_.-]+/g, 'pk.REDACTED')
    .replace(/https:\/\/[a-f0-9]{16,}@([a-z0-9.]*sentry[a-z.]*\/\d+)/g, 'https://REDACTED@$1');
const UA = 'MusicManiacsBot-fixtures/0.1 (+https://github.com/MusicManiacs/musicbrainz-bot)';
const EVENT = 'd36aed22-260c-4069-92ee-d49693b309b5'; // evento con lugar, dos artistas y un link
const pages = {
  'user-bot.html': '/user/ModBot',
  'user-editor.html': '/user/rob',
  'event-with-link.html': `/event/${EVENT}`,
  'event-edits-logged-out.html': `/event/${EVENT}/edits`,
  'event-open-edits.html': `/event/${EVENT}/open_edits`,
};

await fs.mkdir(out, { recursive: true });
for (const [file, route] of Object.entries(pages)) {
  const res = await fetch(`https://musicbrainz.org${route}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  await fs.writeFile(path.join(out, file), sanitize(await res.text()));
  console.log('recorded', file);
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// El login de metabrainz.org se arma con JS: se graba renderizado y sin los tokens de esa visita.
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://test.musicbrainz.org/login');
await page.waitForSelector('form input#username');
const html = sanitize(await page.content())
  .replace(/(id="csrf_token"[^>]*value=")[^"]*/g, '$1REDACTED')
  .replace(/"csrf_token": "[^"]*"/g, '"csrf_token": "REDACTED"')
  .replace(/state%3D[A-Za-z0-9_-]+/g, 'state%3DREDACTED')
  .replace(/code_challenge%3D[A-Za-z0-9_-]+/g, 'code_challenge%3DREDACTED');
await fs.writeFile(path.join(out, 'metabrainz-login.html'), html);
console.log('recorded metabrainz-login.html');
await browser.close();
