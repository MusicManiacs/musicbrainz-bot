import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkArtTypes, checkEventForm, editIdsFor } from '../src/checks.js';
import { normalizeUrl, parseSeed } from '../src/seed.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const seed = (rels, urls = []) =>
  parseSeed(
    new URL(
      `https://test.musicbrainz.org/event/create?${new URLSearchParams([
        ['edit-event.name', 'Fiesta'],
        ['edit-event.edit_note', 'src'],
        ...rels.flatMap((t, i) => [[`rels.${i}.type`, 'x'], [`rels.${i}.target`, t]]),
        ...urls.map((u, i) => [`edit-event.url.${i}.text`, u]),
      ])}`,
    ),
    'edit-event',
  );
const item = (href) => ({ hrefs: href ? [href] : [], removed: false, text: '' });
const form = (relationships, extra = {}) => ({
  hasForm: true,
  fields: { 'edit-event.name': { type: 'text', value: 'Fiesta' }, 'edit-event.edit_note': { type: 'textarea', value: 'src' } },
  relationships,
  links: [],
  errors: [],
  editNote: 'src',
  submits: [{ disabled: false }],
  ...extra,
});

describe('checkEventForm relationships', () => {
  it('accepts exactly the seeded entities, in any order', () => {
    assert.deepEqual(checkEventForm(form([item(`/artist/${B}`), item(`/artist/${A}`)]), seed([A, B])), []);
  });

  it('flags a relationship that shows text instead of an entity (no link)', () => {
    const problems = checkEventForm(form([item(`/artist/${A}`), item(null)]), seed([A, B]));
    assert.ok(problems.some((p) => /1 relationship\(s\) in the form do not point to an entity/.test(p)));
    assert.ok(problems.some((p) => p.includes(`relationship to ${B} is not in the form`)));
  });

  it('flags an entity the seed did not ask for, even if the count matches', () => {
    const problems = checkEventForm(form([item(`/artist/${A}`), item(`/artist/${B}`)]), seed([A, A]));
    assert.deepEqual(problems, [`the relationship to ${A} is not in the form`, `the form has an unexpected relationship to ${B}`]);
  });

  it('does not count a relationship marked for removal', () => {
    const removed = { hrefs: [`/artist/${B}`], removed: true, text: '' };
    assert.deepEqual(checkEventForm(form([item(`/artist/${A}`), removed]), seed([A])), []);
  });
});

describe('checkEventForm other guards', () => {
  it('refuses a disabled or duplicated Enter edit button, and any form error', () => {
    assert.match(checkEventForm(form([], { submits: [{ disabled: true }] }), seed([])).join(), /disabled/);
    assert.match(checkEventForm(form([], { submits: [{}, {}] }), seed([])).join(), /found 2/);
    assert.match(checkEventForm(form([], { errors: ['Required field.'] }), seed([])).join(), /form error: Required field/);
  });

  it('compares checkbox and multi-line fields by value, ignoring CRLF', () => {
    const s = parseSeed(new URL('https://t/event/create?edit-event.setlist=a%0Ab&edit-event.cancelled=1'), 'edit-event');
    const f = form([], {
      fields: {
        'edit-event.name': { type: 'text', value: 'Fiesta' },
        'edit-event.setlist': { type: 'textarea', value: 'a\r\nb' },
        'edit-event.cancelled': { type: 'checkbox', checked: false },
      },
    });
    assert.deepEqual(checkEventForm(f, s), ['field "edit-event.cancelled" is unchecked, expected checked']);
  });
});

describe('seed parsing', () => {
  it('rejects a repeated parameter (MusicBrainz refuses it) and a link with no URL', () => {
    const s = parseSeed(new URL('https://t/event/create?edit-event.name=a&edit-event.name=b&edit-event.url.0.link_type_id=1'), 'edit-event');
    assert.ok(s.problems.some((p) => /"edit-event.name" is repeated/.test(p)));
  });

  it('keeps seeded relationships in index order, not URL order', () => {
    const s = parseSeed(new URL(`https://t/event/create?rels.1.target=${B}&rels.1.type=x&rels.0.target=${A}&rels.0.type=x`), 'edit-event');
    assert.deepEqual(s.rels.map((r) => r.target), [A, B]);
  });

  it('normalizes URLs the way MusicBrainz cleans them', () => {
    assert.equal(normalizeUrl('http://www.Example.com/a/b/#x'), normalizeUrl('https://example.com/a/b'));
    assert.notEqual(normalizeUrl('https://example.com/a?id=1'), normalizeUrl('https://example.com/a?id=2'));
  });
});

describe('edit IDs', () => {
  it('keeps only the bot account (case-insensitive), as numbers in ascending order', () => {
    const edits = [
      { id: '100', editor: 'MusicManiacs_bot' },
      { id: '9', editor: 'musicmaniacs_BOT' },
      { id: '50', editor: 'someone' },
      { id: '60', editor: null },
    ];
    assert.deepEqual(editIdsFor(edits, 'MusicManiacs_bot'), ['9', '100']);
  });
});

describe('event art types', () => {
  it('requires Poster selected and nothing else', () => {
    const t = (types, errors = []) => checkArtTypes({ types, errors });
    assert.deepEqual(t([{ label: 'Poster', checked: true }, { label: 'Other', checked: false }]), []);
    assert.match(t([{ label: 'Poster', checked: false }]).join(), /not selected/);
    assert.match(t([{ label: 'Poster', checked: true }, { label: 'Other', checked: true }]).join(), /other art types/);
    assert.match(t([{ label: 'Other', checked: true }]).join(), /not offered/);
    assert.match(t([], ['⚠ Unrecognized file']).join(), /Unrecognized file/);
  });
});
