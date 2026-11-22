// Decisiones del bot sobre lo que ve en MusicBrainz. Código puro: recibe lo que
// extrajo snapshots.js y devuelve una lista de problemas. Lista vacía = se puede
// enviar. "Ante la duda, no envía": cualquier diferencia con lo precargado cuenta.
import { normalizeUrl } from './seed.js';

const ENTITY_HREF = /^\/(artist|place|area|series|label|recording|release|release-group|work|event|instrument)\/([0-9a-f-]{36})$/i;
const nl = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

function entityMbids(hrefs) {
  return hrefs
    .map((h) => ENTITY_HREF.exec(h.split(/[?#]/)[0]))
    .filter(Boolean)
    .map((m) => m[2].toLowerCase());
}

export function checkEventForm(snap, seed) {
  if (!snap.hasForm) return ['the event form was not found on the page'];
  const problems = [];

  // Campos precargados: tienen que estar y tener exactamente el valor pedido.
  for (const [name, expected] of Object.entries(seed.fields)) {
    const field = snap.fields[name];
    if (!field) {
      problems.push(`seeded field "${name}" is missing from the form`);
    } else if (field.type === 'checkbox') {
      const want = ['1', 'on', 'true'].includes(expected.toLowerCase());
      if (field.checked !== want) problems.push(`field "${name}" is ${field.checked ? 'checked' : 'unchecked'}, expected ${want ? 'checked' : 'unchecked'}`);
    } else if (nl(field.value) !== nl(expected)) {
      problems.push(`field "${name}" is "${nl(field.value)}", expected "${nl(expected)}"`);
    }
  }
  if (!nl(snap.fields['edit-event.name']?.value)) problems.push('the event name is empty');
  if (!nl(snap.editNote)) problems.push('the edit note is empty (it must carry the sources)');

  // Relaciones: cada una tiene que apuntar a una entidad y ser la pedida.
  const shown = snap.relationships.filter((r) => !r.removed);
  const shownMbids = shown.map((r) => entityMbids(r.hrefs)[0]).filter(Boolean);
  const unresolved = shown.length - shownMbids.length;
  if (unresolved > 0) problems.push(`${unresolved} relationship(s) in the form do not point to an entity`);
  const remaining = [...shownMbids];
  for (const rel of seed.rels) {
    const mbid = rel.target?.toLowerCase();
    const at = remaining.indexOf(mbid);
    if (at < 0) problems.push(`the relationship to ${rel.target} is not in the form`);
    else remaining.splice(at, 1);
  }
  for (const mbid of remaining) problems.push(`the form has an unexpected relationship to ${mbid}`);

  // Links externos: cada source precargada tiene que estar.
  const shownLinks = snap.links.filter((l) => l.value.trim());
  const shownUrls = shownLinks.map((l) => normalizeUrl(l.value));
  for (const url of seed.urls) {
    if (!shownUrls.includes(normalizeUrl(url))) problems.push(`the external link ${url} is not in the form`);
  }
  for (const link of shownLinks) {
    for (const error of link.errors) problems.push(`external link ${link.value}: ${error}`);
  }

  for (const error of snap.errors) problems.push(`form error: ${error}`);

  if (snap.submits.length !== 1) problems.push(`expected one "Enter edit" button, found ${snap.submits.length}`);
  else if (snap.submits[0].disabled) problems.push('the "Enter edit" button is disabled');

  return problems;
}

// Qué falta en la página del evento ya creado. Lista vacía = quedó todo.
export function checkEventPage(snap, seed) {
  const missing = [];
  const wantedName = seed.fields['edit-event.name'];
  if (wantedName && nl(snap.title) !== nl(wantedName)) {
    missing.push(`the event is titled "${nl(snap.title)}", expected "${nl(wantedName)}"`);
  }
  const shown = entityMbids(snap.hrefs);
  for (const rel of seed.rels) {
    if (rel.target && !shown.includes(rel.target.toLowerCase())) missing.push(`the relationship to ${rel.target} was not created`);
  }
  const external = snap.hrefs.filter((h) => /^https?:/i.test(h)).map(normalizeUrl);
  for (const url of seed.urls) {
    if (!external.includes(normalizeUrl(url))) missing.push(`the link ${url} was not created`);
  }
  return missing;
}

// IDs (numéricos, ascendentes) de las ediciones de `username` en una lista de ediciones.
export function editIdsFor(edits, username) {
  const who = username.toLowerCase();
  return edits
    .filter((e) => e.id && e.editor && e.editor.toLowerCase() === who)
    .map((e) => e.id)
    .sort((a, b) => Number(a) - Number(b));
}

export function isBotAccount(profile) {
  return profile.types.some((t) => t.href === '/doc/Editor#Bot');
}

export function checkArtForm(snap, seed) {
  if (!snap.hasForm) return ['the add event art form was not found on the page'];
  const problems = [];
  if (!snap.hasFileInput) problems.push('the file input was not found');
  if (!snap.submit) problems.push('the "Enter edit" button was not found');
  if (!nl(snap.editNote)) problems.push('the edit note is empty');
  for (const [name, expected] of Object.entries(seed.fields)) {
    if (name !== snap.editNoteName) problems.push(`seeded field "${name}" is not a field of this form`);
    else if (nl(snap.editNote) !== nl(expected)) problems.push(`the edit note is not the seeded one`);
  }
  if (snap.archiveWarning) problems.push('the Internet Archive reports difficulties; adding images is unlikely to work');
  return problems;
}

// Después de elegir el archivo: que se ofrezca el tipo Poster y quede sólo ese.
export function checkArtTypes(upload) {
  const problems = [...upload.errors.map((e) => `upload error: ${e}`)];
  const poster = upload.types.filter((t) => t.label === 'Poster');
  if (poster.length !== 1) problems.push('the "Poster" art type is not offered by the form');
  else if (!poster[0].checked) problems.push('the "Poster" type is not selected');
  const others = upload.types.filter((t) => t.label !== 'Poster' && t.checked);
  if (others.length) problems.push(`other art types are selected: ${others.map((t) => t.label).join(', ')}`);
  return problems;
}
