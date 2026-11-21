// Smoke test EN VIVO contra test.musicbrainz.org (nunca producción).
//
//   MB_BOT_USERNAME=... MB_BOT_PASSWORD=... npm run smoke
//
// Por default NO envía nada: se loguea, lee el tipo de la cuenta y abre el form de
// crear evento precargado pasando por todos los chequeos (dry run).
//
//   SMOKE_SUBMIT=true            envía de verdad un evento de prueba a test.musicbrainz.org
//   SMOKE_ARTIST_MBID / SMOKE_PLACE_MBID   MBIDs que existan en test, para probar las relaciones
//   SMOKE_IMAGE_URL              con SMOKE_SUBMIT=true, sube también esa imagen como Poster
import { Captures } from '../src/captures.js';
import { isConfiguredForMusicBrainz, loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { BotService } from '../src/service.js';

const env = process.env;
const config = loadConfig({ ...env, MB_ALLOW_PRODUCTION: 'false', DATA_DIR: env.DATA_DIR ?? 'data/smoke' });
if (!isConfiguredForMusicBrainz(config)) {
  console.error('Set MB_BOT_USERNAME and MB_BOT_PASSWORD (an account of test.metabrainz.org).');
  process.exit(2);
}
const submit = env.SMOKE_SUBMIT === 'true';
const MB = 'https://test.musicbrainz.org';
const MAIN_PERFORMER = '936c7c95-3156-3889-a062-8a0cd57f8946';
const HELD_AT = 'e2c6f697-07dc-38b1-be0b-83d740165532';

const log = createLogger({ secrets: [config.password, config.serviceToken] });
const captures = new Captures(config.dataDir, config.capturesTtlDays);
await captures.init();
const service = new BotService({ config, log, captures, dryRun: !submit });

const show = (title, value) => console.log(`\n== ${title}\n${JSON.stringify(value, null, 2)}`);
let failed = false;
try {
  show('account', await service.account('test'));

  const stamp = new Date().toISOString();
  const q = new URLSearchParams({
    'edit-event.name': `musicbrainz-bot smoke test ${stamp}`,
    'edit-event.period.begin_date.year': String(new Date().getUTCFullYear() + 1),
    'edit-event.period.begin_date.month': '1',
    'edit-event.period.begin_date.day': '1',
    'edit-event.edit_note': 'Smoke test of https://github.com/MusicManiacs/musicbrainz-bot on test.musicbrainz.org. Safe to ignore.',
    'edit-event.url.0.text': 'https://github.com/MusicManiacs/musicbrainz-bot',
  });
  let n = 0;
  if (env.SMOKE_ARTIST_MBID) {
    q.set(`rels.${n}.type`, MAIN_PERFORMER);
    q.set(`rels.${n++}.target`, env.SMOKE_ARTIST_MBID);
  }
  if (env.SMOKE_PLACE_MBID) {
    q.set(`rels.${n}.type`, HELD_AT);
    q.set(`rels.${n++}.target`, env.SMOKE_PLACE_MBID);
  }
  const event = await service.createEdit({ kind: 'event', server: 'test', url: `${MB}/event/create?${q}` });
  show(submit ? 'event' : 'event (dry run: nothing was sent)', event);
  failed ||= submit ? event.status !== 'created' : event.error?.code !== 'dry_run';

  if (submit && event.status === 'created' && env.SMOKE_IMAGE_URL) {
    const art = new URLSearchParams({ 'add-event-art.edit_note': 'Smoke test poster. Safe to ignore.' });
    const result = await service.createEdit({
      kind: 'event_art',
      server: 'test',
      url: `${MB}/event/${event.mbid}/add-event-art?${art}`,
      image_url: env.SMOKE_IMAGE_URL,
    });
    show('event_art', result);
    failed ||= result.status !== 'created';
  }
  console.log(`\nCaptures are in ${captures.dir}`);
} finally {
  await service.close();
}
process.exit(failed ? 1 : 0);
