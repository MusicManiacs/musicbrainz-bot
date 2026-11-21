import { checkArtForm, checkArtTypes } from '../checks.js';
import { downloadImage, ImageError } from '../image.js';
import { parseSeed } from '../seed.js';
import { snapshotArtForm, snapshotArtUpload } from '../snapshots.js';
import { editIdsOn, makeResults } from './common.js';

const FORM_NAME = 'add-event-art';

// kind: event_art — sube la imagen como Poster al evento (add event art).
// `mbid` es el del evento (viene en la URL); la edición del poster se vota, así
// que se identifica por diferencia con las ediciones abiertas de antes.
export async function addEventArt(ctx, { url, mbid, imageUrl }) {
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

    let image;
    try {
      image = await downloadImage(imageUrl, { maxBytes: config.imageMaxBytes, userAgent: config.userAgent });
    } catch (error) {
      if (error instanceof ImageError) return r.invalid('image_unavailable', error.message);
      throw error;
    }

    const openBefore = await editIdsOn(session, `/event/${mbid}/open_edits`);

    await session.goto(url.href);
    try {
      await page.waitForSelector('form#add-event-art', { timeout: config.navigationTimeoutMs });
    } catch {
      await capture('before');
      return r.invalid('form_not_found', 'the add event art form did not load; nothing was sent');
    }
    const formProblems = checkArtForm(await snapshotArtForm(page), seed);
    if (formProblems.length) {
      await capture('before');
      return r.invalid('form_check_failed', 'the form is not the expected one; nothing was sent', formProblems);
    }

    await page.locator('input.add-files').setInputFiles({ name: image.name, mimeType: image.mimeType, buffer: image.buffer });
    // Esperar a que el form ofrezca los tipos (o muestre que no reconoce el archivo).
    await page
      .waitForFunction(() => {
        const shown = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        return [...document.querySelectorAll('.event-art-type-checkboxes input.type, span.msg.error')].some(shown);
      })
      .catch(() => {});
    const poster = page.locator('.event-art-type-checkboxes label').filter({ hasText: /^\s*Poster\s*$/ });
    if ((await poster.count()) === 1) await poster.locator('input.type').check();
    const typeProblems = checkArtTypes(await snapshotArtUpload(page));
    await capture('before');
    if (typeProblems.length) return r.invalid('form_check_failed', 'the form is not the expected one; nothing was sent', typeProblems);

    if (ctx.dryRun) return r.invalid('dry_run', 'dry run: the form passed every check; nothing was sent');

    await ctx.waitBeforeSubmit();
    clicked = true;
    const landedUrl = `${mb}/event/${mbid}/event-art`;
    const redirected = page
      .waitForURL((u) => u.origin + u.pathname === landedUrl, { timeout: config.submitTimeoutMs, waitUntil: 'domcontentloaded' })
      .then(() => 'redirect', () => 'timeout');
    const errorShown = page
      .locator('span.msg.error')
      .first()
      .waitFor({ state: 'visible', timeout: config.submitTimeoutMs })
      .then(() => 'error', () => 'timeout');
    await page.locator('#add-event-art-submit').click();
    const outcome = await Promise.race([redirected, errorShown]);

    if (outcome !== 'redirect') {
      await capture('after');
      const errors = (await snapshotArtUpload(page).catch(() => ({ errors: [] }))).errors;
      // "Error creating edit" es la única etapa en la que se envía la edición.
      if (outcome === 'error' && !errors.some((e) => /creating edit/i.test(e))) {
        return r.invalid('upload_failed', 'the image could not be uploaded; no edit was entered', errors);
      }
      return r.uncertain('no_redirect', 'Enter edit was clicked but the redirect to the event art page never arrived', errors);
    }
    await capture('after');

    const warnings = [];
    let editIds = [];
    try {
      const after = await editIdsOn(session, `/event/${mbid}/open_edits`);
      editIds = after.filter((id) => !openBefore.includes(id));
    } catch (error) {
      warnings.push(`could not read the open edits: ${error.message}`);
    }
    const ok = editIds.length > 0;
    return r.created({
      mbid,
      edit_ids: editIds,
      verification: { ok, missing: ok ? [] : ['the add event art edit was not found among the open edits'] },
      warnings,
    });
  } catch (error) {
    if (clicked) {
      await capture('after').catch(() => {});
      return r.uncertain('unexpected_error', error.message);
    }
    return r.invalid(error.code ?? 'unexpected_error', error.message);
  }
}
