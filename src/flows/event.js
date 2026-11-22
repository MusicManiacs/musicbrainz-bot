import { checkEventForm, checkEventPage } from '../checks.js';
import { parseSeed } from '../seed.js';
import { snapshotEventForm, snapshotEventPage } from '../snapshots.js';
import { editIdsOn, makeResults, UUID } from './common.js';

const FORM_NAME = 'edit-event';
const SUBMIT = 'form.edit-event button.submit.positive';
const EVENT_PATH = new RegExp(`^/event/(${UUID})$`, 'i');

// kind: event — abre el form de crear evento precargado, lo verifica, envía y
// devuelve el MBID y las ediciones. Nunca clickea si algo no es lo esperado.
export async function createEvent(ctx, { url }) {
  const { session, config } = ctx;
  const { page } = session;
  const mb = session.server.mb;
  const captures = [];
  const r = makeResults(captures);
  const capture = async (label) => {
    const c = await ctx.capture(page, label);
    if (c) captures.push(c);
  };
  let clicked = false;

  try {
    const seed = parseSeed(url, FORM_NAME);
    if (seed.problems.length) return r.invalid('bad_seed', 'the seeded URL is not valid; nothing was sent', seed.problems);

    await session.goto(url.href);
    try {
      await page.waitForSelector('form.edit-event', { timeout: config.navigationTimeoutMs });
    } catch {
      await capture('before');
      return r.invalid('form_not_found', 'the event form did not load; nothing was sent');
    }
    if (seed.rels.length) {
      // El editor de relaciones carga después del form; si no llega, el chequeo lo informa.
      await page
        .waitForFunction(
          (n) => document.querySelectorAll('#relationship-editor .relationship-item').length >= n,
          seed.rels.length,
          { timeout: 15000 },
        )
        .catch(() => {});
    }

    const problems = checkEventForm(await snapshotEventForm(page), seed);
    await capture('before');
    if (problems.length) return r.invalid('form_check_failed', 'the form is not the expected one; nothing was sent', problems);

    if (ctx.dryRun) return r.invalid('dry_run', 'dry run: the form passed every check; nothing was sent');

    await ctx.waitBeforeSubmit();
    clicked = true;
    const landed = page.waitForURL((u) => u.origin === mb && EVENT_PATH.test(u.pathname), {
      timeout: config.submitTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    landed.catch(() => {});
    await page.locator(SUBMIT).click();
    try {
      await landed;
    } catch {
      await capture('after');
      const snap = await snapshotEventForm(page).catch(() => ({ hasForm: false }));
      if (snap.hasForm && snap.errors.length) {
        return r.invalid('server_rejected', 'MusicBrainz returned the form with errors; no edit was entered', snap.errors);
      }
      return r.uncertain('no_redirect', 'Enter edit was clicked but the redirect to the new event never arrived');
    }

    const mbid = EVENT_PATH.exec(new URL(page.url()).pathname)[1].toLowerCase();
    await capture('after');

    // Desde acá el evento existe: nada de lo que falle puede perder el MBID.
    let verification;
    try {
      const missing = checkEventPage(await snapshotEventPage(page), seed);
      verification = { ok: missing.length === 0, missing };
    } catch (error) {
      verification = { ok: false, missing: [`could not verify the event page: ${error.message}`] };
    }
    const warnings = [];
    let editIds = [];
    try {
      editIds = await editIdsOn(session, `/event/${mbid}/edits`);
      if (!editIds.length) warnings.push('no edits by the bot account were found in the event edit history');
    } catch (error) {
      warnings.push(`could not read the event edit history: ${error.message}`);
    }
    return r.created({ mbid, edit_ids: editIds, verification, warnings });
  } catch (error) {
    if (clicked) {
      await capture('after').catch(() => {});
      return r.uncertain('unexpected_error', `${error.message}`);
    }
    return r.invalid(error.code ?? 'unexpected_error', error.message);
  }
}
