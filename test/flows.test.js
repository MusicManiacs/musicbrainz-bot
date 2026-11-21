import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createHttpServer } from '../src/http.js';
import { FakeMusicBrainz } from './helpers/fake-mb.js';
import { ARTIST_A, artUrl, eventUrl, imageServer, makeService, silentLog, SOURCE } from './helpers/setup.js';

const closers = [];
async function setup(behavior = {}, env = {}, fakeOptions = {}, serviceOptions = {}) {
  const fake = new FakeMusicBrainz({ ...fakeOptions, ...behavior });
  const ctx = await makeService(fake, env, serviceOptions);
  closers.push(ctx.close);
  return { fake, ...ctx };
}
after(async () => {
  for (const close of closers) await close();
});

const post = (service, url, extra = {}) => service.createEdit({ kind: 'event', server: 'test', url, ...extra });

describe('event', () => {
  it('creates the event, reads the MBID and only the bot account edit IDs, and takes before/after captures', async () => {
    const { service, fake, captures } = await setup();
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'created');
    const [mbid] = [...fake.created.keys()];
    assert.equal(result.mbid, mbid);
    assert.deepEqual(result.edit_ids, ['5001', '5002']); // 5003 es de otro editor
    assert.deepEqual(result.verification, { ok: true, missing: [] });
    assert.equal(result.error, null);
    assert.equal(fake.posts.length, 1);
    assert.deepEqual(result.captures.map((c) => c.label), ['before', 'after']);
    for (const c of result.captures) assert.ok(await captures.file(c.id), `capture ${c.id} exists`);
  });

  it('rejects a seeded relationship that points to text instead of an MBID without even opening the form', async () => {
    const { service, fake } = await setup();
    const url = eventUrl({ rels: [['936c7c95-3156-3889-a062-8a0cd57f8946', 'Beltran']] });
    const result = await post(service, url);

    assert.equal(result.status, 'invalid');
    assert.equal(result.error.code, 'bad_seed');
    assert.match(result.error.problems.join('\n'), /not point to an entity/);
    assert.equal(fake.posts.length, 0);
    assert.equal(fake.logins, 0);
  });

  it('does not click when a seeded field is missing from the form', async () => {
    const { service, fake } = await setup({ omitFields: ['edit-event.period.begin_date.year'] });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'invalid');
    assert.match(result.error.problems.join('\n'), /"edit-event.period.begin_date.year" is missing/);
    assert.equal(fake.posts.length, 0);
  });

  it('does not click when the form shows validation errors', async () => {
    const { service, fake } = await setup({ formErrors: ['Not a valid time.'] });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'invalid');
    assert.match(result.error.problems.join('\n'), /Not a valid time/);
    assert.equal(fake.posts.length, 0);
  });

  it('does not click with an empty edit note', async () => {
    const { service, fake } = await setup();
    const result = await post(service, eventUrl({ note: '' }));

    assert.equal(result.status, 'invalid');
    assert.match(result.error.problems.join('\n'), /edit note is empty/);
    assert.equal(fake.posts.length, 0);
  });

  it('reports invalid (not uncertain) when MusicBrainz sends the form back with errors after Enter edit', async () => {
    const { service, fake } = await setup({ submit: 'validation_error' });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'invalid');
    assert.equal(result.error.code, 'server_rejected');
    assert.equal(fake.posts.length, 1);
    assert.equal(fake.created.size, 0);
  });

  it('reports uncertain when Enter edit was clicked and the redirect never arrives', async () => {
    const { service, fake } = await setup({ submit: 'no_redirect' });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'uncertain');
    assert.equal(result.mbid, null);
    assert.equal(fake.posts.length, 1);
    assert.deepEqual(result.captures.map((c) => c.label), ['before', 'after']);
  });

  it('keeps the MBID and lists what is missing when the created event lacks a link', async () => {
    const { service } = await setup({ dropFromEventPage: [SOURCE, ARTIST_A] });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'created');
    assert.ok(result.mbid);
    assert.equal(result.verification.ok, false);
    assert.equal(result.verification.missing.length, 2);
    assert.match(result.verification.missing.join('\n'), new RegExp(`relationship to ${ARTIST_A}`));
    assert.match(result.verification.missing.join('\n'), /fiesta-x was not created/);
  });

  it('logs in again when the session expires and still submits once', async () => {
    const { service, fake } = await setup();
    await post(service, eventUrl({ name: 'First' }));
    assert.equal(fake.logins, 1);
    fake.expireSession();
    const result = await post(service, eventUrl({ name: 'Second' }));

    assert.equal(result.status, 'created');
    assert.equal(fake.logins, 2);
    assert.equal(fake.posts.length, 2);
  });

  it('never clicks when the bot cannot log in', async () => {
    const { service, fake } = await setup({}, {}, { password: 'something else' });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'invalid');
    assert.equal(result.error.code, 'login_failed');
    assert.equal(fake.posts.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /correct horse/);
  });

  it('refuses to act as a different account than MB_BOT_USERNAME', async () => {
    const { service, fake } = await setup({}, {}, { displayName: 'someone_else' });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'invalid');
    assert.equal(result.error.code, 'account_mismatch');
    assert.equal(fake.posts.length, 0);
  });

  it('dry run (used by the smoke script) runs every check and sends nothing', async () => {
    const { service, fake } = await setup({}, {}, {}, { dryRun: true });
    const result = await post(service, eventUrl());

    assert.equal(result.status, 'invalid');
    assert.equal(result.error.code, 'dry_run');
    assert.equal(fake.posts.length, 0);
    assert.deepEqual(result.captures.map((c) => c.label), ['before']);
  });

  it('waits the configured pause between two submissions', async () => {
    const { service, fake } = await setup({}, { PAUSE_BETWEEN_SUBMITS_MS: '800' });
    await post(service, eventUrl({ name: 'One' }));
    await post(service, eventUrl({ name: 'Two' }));

    assert.equal(fake.posts.length, 2);
    assert.ok(fake.posts[1].at - fake.posts[0].at >= 780, `gap was ${fake.posts[1].at - fake.posts[0].at}ms`);
  });

  it('handles one request at a time: a concurrent one gets 409 busy', async () => {
    const { service, fake } = await setup();
    const first = post(service, eventUrl());
    await assert.rejects(post(service, eventUrl({ name: 'Other' })), { code: 'busy', httpStatus: 409 });
    assert.equal((await first).status, 'created');
    assert.equal(fake.posts.length, 1);
  });
});

describe('event_art', () => {
  async function withImages(fn) {
    const images = await imageServer();
    try {
      await fn(images);
    } finally {
      await images.close();
    }
  }
  const art = (service, mbid, image_url, note) =>
    service.createEdit({ kind: 'event_art', server: 'test', url: artUrl(mbid, note), image_url });

  it('uploads the image as a Poster and returns the new (open) edit ID only', async () => {
    await withImages(async ({ base }) => {
      const { service, fake } = await setup();
      const mbid = '44444444-4444-4444-8444-444444444444';
      fake.openEdits.set(mbid, [{ id: 4000, editor: 'MusicManiacs_bot' }]); // un poster anterior, abierto

      const result = await art(service, mbid, `${base}/poster.png`);
      assert.equal(result.status, 'created');
      assert.equal(result.mbid, mbid);
      assert.deepEqual(result.edit_ids, ['5001']);
      assert.deepEqual(fake.uploads[0].body.types, ['Poster']);
      assert.equal(fake.uploads[0].body.name, 'poster.png');
      assert.deepEqual(result.captures.map((c) => c.label), ['before', 'after']);
    });
  });

  it('rejects an image whose bytes are not an image, whatever the server says, before touching MusicBrainz', async () => {
    await withImages(async ({ base }) => {
      const { service, fake } = await setup();
      const result = await art(service, '44444444-4444-4444-8444-444444444444', `${base}/lying.png`);
      assert.equal(result.status, 'invalid');
      assert.equal(result.error.code, 'image_unavailable');
      assert.equal(fake.uploads.length, 0);
    });
  });

  it('does not upload when the Internet Archive reports difficulties', async () => {
    await withImages(async ({ base }) => {
      const { service, fake } = await setup({ archiveWarning: true });
      const result = await art(service, '44444444-4444-4444-8444-444444444444', `${base}/poster.png`);
      assert.equal(result.status, 'invalid');
      assert.match(result.error.problems.join('\n'), /Internet Archive/);
      assert.equal(fake.uploads.length, 0);
    });
  });

  it('does not upload without an edit note', async () => {
    await withImages(async ({ base }) => {
      const { service, fake } = await setup();
      const result = await art(service, '44444444-4444-4444-8444-444444444444', `${base}/poster.png`, '');
      assert.equal(result.status, 'invalid');
      assert.match(result.error.problems.join('\n'), /edit note is empty/);
      assert.equal(fake.uploads.length, 0);
    });
  });

  it('reports invalid when the upload fails, and uncertain when creating the edit fails or hangs', async () => {
    await withImages(async ({ base }) => {
      const mbid = '44444444-4444-4444-8444-444444444444';
      const failed = await setup({ art: 'upload_error' });
      const r1 = await art(failed.service, mbid, `${base}/poster.png`);
      assert.equal(r1.status, 'invalid');
      assert.equal(r1.error.code, 'upload_failed');

      const creating = await setup({ art: 'submit_error' });
      const r2 = await art(creating.service, mbid, `${base}/poster.png`);
      assert.equal(r2.status, 'uncertain');

      const hung = await setup({ art: 'hang' }, { SUBMIT_TIMEOUT_MS: '1200' });
      const r3 = await art(hung.service, mbid, `${base}/poster.png`);
      assert.equal(r3.status, 'uncertain');
      assert.equal(r3.error.code, 'no_redirect');
    });
  });
});

describe('HTTP contract', () => {
  it('POST /edits returns the documented body, and the captures it lists can be downloaded', async () => {
    const { service, captures, config } = await setup();
    const server = createHttpServer({ service, captures, config, log: silentLog });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { authorization: 'Bearer service-token', 'content-type': 'application/json' };

    const res = await fetch(`${base}/edits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'event', server: 'test', url: eventUrl() }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['candidates', 'captures', 'edit_ids', 'error', 'mbid', 'status', 'verification', 'warnings']);
    assert.equal(body.status, 'created');
    assert.match(body.mbid, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body.candidates, []);

    const shot = await fetch(base + body.captures[0].url, { headers });
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/png');
    assert.deepEqual([...Buffer.from(await shot.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('account', () => {
  it('reports the account type from its profile page (recorded pages: a Bot and a regular editor)', async () => {
    const bot = await setup({}, { MB_BOT_USERNAME: 'ModBot' }, { username: 'ModBot' });
    assert.deepEqual(await bot.service.account('test'), {
      server: 'test',
      username: 'ModBot',
      logged_in: true,
      is_bot: true,
      user_types: ['Internal/Bot'],
      error: null,
    });

    const rob = await setup({}, { MB_BOT_USERNAME: 'rob' }, { username: 'rob' });
    const account = await rob.service.account('test');
    assert.equal(account.logged_in, true);
    assert.equal(account.is_bot, false);
    assert.ok(account.user_types.includes('Auto-editor'));
  });

  it('says logged_in false (not an error) when the credentials are wrong', async () => {
    const { service } = await setup({}, {}, { password: 'something else' });
    const account = await service.account('test');
    assert.equal(account.logged_in, false);
    assert.equal(account.is_bot, false);
    assert.equal(account.error.code, 'login_failed');
  });
});

