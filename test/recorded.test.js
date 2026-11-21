// Los parsers contra páginas que MusicBrainz sirvió de verdad (test/fixtures/recorded).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { chromium } from 'playwright';

import { checkEventPage, editIdsFor, isBotAccount } from '../src/checks.js';
import { parseSeed } from '../src/seed.js';
import { snapshotEdits, snapshotEventPage, snapshotUserProfile } from '../src/snapshots.js';
import { FakeMusicBrainz, MB, RECORDED_EVENT } from './helpers/fake-mb.js';

let browser;
let page;
const fake = new FakeMusicBrainz();
before(async () => {
  const { args, contextOptions } = await fake.start();
  browser = await chromium.launch({ args });
  const context = await browser.newContext({ locale: 'en-US', ...contextOptions });
  page = await context.newPage();
});
after(async () => {
  await browser.close();
  await fake.stop();
});

// El evento grabado: "Commonwealth Country" (2009-07-09), lugar y dos artistas.
const EVENT = {
  name: 'Commonwealth Country',
  place: '043a722b-077f-40d9-ac87-43a768e9c8a6',
  chesney: '5dca4d22-d6c8-4e70-8ca1-4543e43353c7',
  swift: '20244d07-534f-4eff-b4d4-930878889970',
  setlist: 'https://www.setlist.fm/festival/2009/commonwealth-country-2009-13d74145.html',
};
const seedFor = ({ targets, urls, name = EVENT.name }) =>
  parseSeed(
    new URL(
      `${MB}/event/create?${new URLSearchParams([
        ['edit-event.name', name],
        ...targets.flatMap((t, i) => [[`rels.${i}.type`, 'x'], [`rels.${i}.target`, t]]),
        ...urls.map((u, i) => [`edit-event.url.${i}.text`, u]),
      ])}`,
    ),
    'edit-event',
  );

describe('recorded event page', () => {
  it('finds the relationships, the place and the link that the page really shows', async () => {
    await page.goto(`${MB}/event/${RECORDED_EVENT}`);
    const seed = seedFor({ targets: [EVENT.chesney, EVENT.swift, EVENT.place], urls: [EVENT.setlist] });
    assert.deepEqual(checkEventPage(await snapshotEventPage(page), seed), []);
  });

  it('reports what the page does not have: another artist, another link, another name', async () => {
    await page.goto(`${MB}/event/${RECORDED_EVENT}`);
    const other = '99999999-9999-4999-8999-999999999999';
    const seed = seedFor({ targets: [EVENT.chesney, other], urls: ['https://example.com/nope'], name: 'Another Name' });
    const missing = checkEventPage(await snapshotEventPage(page), seed);
    assert.equal(missing.length, 3);
    assert.match(missing.join('\n'), /titled "Commonwealth Country"/);
    assert.match(missing.join('\n'), new RegExp(other));
    assert.match(missing.join('\n'), /example.com\/nope/);
  });

  it('matches a link even if MusicBrainz shows it with other scheme, www or trailing slash', async () => {
    await page.goto(`${MB}/event/${RECORDED_EVENT}`);
    const seed = seedFor({ targets: [], urls: ['http://setlist.fm/festival/2009/commonwealth-country-2009-13d74145.html/'] });
    assert.deepEqual(checkEventPage(await snapshotEventPage(page), seed), []);
  });
});

describe('recorded edit lists', () => {
  it('reads every edit ID from the history; the editor is hidden when logged out, so none is the bot’s', async () => {
    await page.goto(`${MB}/event/${RECORDED_EVENT}/edits`);
    const edits = await snapshotEdits(page);
    assert.deepEqual(edits.map((e) => e.id), ['96376240', '96376239', '96376238', '96376237', '96376236', '96376235']);
    assert.ok(edits.every((e) => e.editor === null));
    assert.deepEqual(editIdsFor(edits, 'MusicManiacs_bot'), []);
  });

  it('reads an empty open-edits page as no edits', async () => {
    await page.goto(`${MB}/event/${RECORDED_EVENT}/open_edits`);
    assert.deepEqual(await snapshotEdits(page), []);
  });
});

describe('recorded user profiles', () => {
  it('recognises the Bot user type by its link, not by its translated text', async () => {
    await page.goto(`${MB}/user/ModBot`);
    const profile = await snapshotUserProfile(page);
    assert.equal(isBotAccount(profile), true);
    assert.deepEqual(profile.types.map((t) => t.href), ['/doc/Editor#Bot']);
  });

  it('does not take a regular editor for a bot', async () => {
    await page.goto(`${MB}/user/rob`);
    assert.equal(isBotAccount(await snapshotUserProfile(page)), false);
  });
});
