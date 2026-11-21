// Un "MusicBrainz" para tests: un servidor HTTPS local (con redirects, formularios y
// cookies de verdad) al que Chromium resuelve test.musicbrainz.org y
// test.metabrainz.org. Cualquier otro host falla al resolver, así que ningún test
// puede llegar a internet.
//
// - Páginas GRABADAS (test/fixtures/recorded, tal cual las sirvió MusicBrainz):
//   login de metabrainz.org, perfiles de usuario, páginas de evento y de ediciones.
// - Páginas RECONSTRUIDAS (acá abajo): las que sólo se ven con sesión iniciada —
//   el form de crear evento, el de add-event-art, y las listas de ediciones con el
//   editor visible. Se escribieron a mano con el mismo DOM (clases, ids, `name`) que
//   renderiza musicbrainz-server (commit 42caf9a), porque grabarlas pide la cuenta
//   del bot, que todavía no existe. El smoke test en vivo cubre esa diferencia.
//
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/recorded');
const recorded = (name) => fs.readFileSync(path.join(RECORDED, name), 'utf8');

export const MB = 'https://test.musicbrainz.org';
export const AUTH = 'https://test.metabrainz.org';
export const LINK_TYPES = {
  mainPerformer: '936c7c95-3156-3889-a062-8a0cd57f8946',
  heldAt: 'e2c6f697-07dc-38b1-be0b-83d740165532',
};
export const RECORDED_EVENT = 'd36aed22-260c-4069-92ee-d49693b309b5';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const page = (body, header = '') =>
  `<!DOCTYPE html><html lang="en"><body><div class="header">${header}</div>${body}</body></html>`;
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export class FakeMusicBrainz {
  constructor({ username = 'MusicManiacs_bot', password = 'correct horse', displayName, ...behavior } = {}) {
    this.username = username;
    this.displayName = displayName ?? username; // lo que muestra el menú de la cuenta
    this.password = password;
    this.behavior = {
      submit: 'ok', // ok | validation_error | no_redirect
      art: 'ok', // ok | upload_error | submit_error | hang
      archiveWarning: false,
      omitFields: [],
      formErrors: [],
      dropFromEventPage: [],
      ...behavior,
    };
    this.loggedIn = false;
    this.logins = 0;
    this.posts = []; // POST /event/create recibidos
    this.uploads = []; // POST de arte recibidos
    this.created = new Map(); // mbid -> { search, name }
    this.openEdits = new Map(); // mbid -> [{id, editor}]
    this.nextEdit = 5000;
    this.sessionExpiresOnNextForm = false;
  }

  expireSession() {
    this.sessionExpiresOnNextForm = true;
  }

  // Levanta el servidor y devuelve lo que hay que pasarle a Chromium.
  async start() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-mb-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
      '-keyout', key, '-out', cert, '-subj', '/CN=test.musicbrainz.org',
      '-addext', 'subjectAltName=DNS:test.musicbrainz.org,DNS:test.metabrainz.org',
    ], { stdio: 'ignore' });
    this.server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      this.handle(req, res).catch((error) => {
        res.writeHead(500).end(String(error.stack));
      });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address();
    fs.rmSync(dir, { recursive: true, force: true });
    return {
      args: [
        `--host-resolver-rules=MAP test.musicbrainz.org 127.0.0.1:${port}, MAP test.metabrainz.org 127.0.0.1:${port}, MAP * ~NOTFOUND`,
      ],
      contextOptions: { ignoreHTTPSErrors: true },
    };
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  async handle(req, res) {
    const origin = `https://${req.headers.host.split(':')[0]}`;
    const url = new URL(req.url, origin);
    const method = req.method;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const html = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const redirect = (to) => {
      res.writeHead(302, { location: to });
      res.end();
    };

    if (origin === AUTH) {
      if (url.pathname !== '/login') return html('not found', 404);
      if (method === 'POST') {
        const form = new URLSearchParams(bodyText);
        if (form.get('username') === this.username && form.get('password') === this.password) {
          this.loggedIn = true;
          this.logins += 1;
          return redirect(`${MB}/`);
        }
        return html(recorded('metabrainz-login.html').replace('<form', '<div class="alert alert-danger">Incorrect username or password</div><form'));
      }
      return html(recorded('metabrainz-login.html'));
    }
    if (origin !== MB) return html('unknown host', 404);

    const p = url.pathname;
    if (p === '/login') return redirect(this.loggedIn ? `${MB}/` : `${AUTH}/login?next=%2Foauth2%2Fauthorize`);
    if (p === '/') return html(this.home());

    let m;
    if ((m = p.match(/^\/user\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]);
      return html(recorded(name === 'ModBot' ? 'user-bot.html' : 'user-editor.html'));
    }

    // Páginas grabadas del evento de ejemplo (sólo lectura).
    if (p === `/event/${RECORDED_EVENT}`) return html(recorded('event-with-link.html'));
    if (p === `/event/${RECORDED_EVENT}/edits`) return html(recorded('event-edits-logged-out.html'));
    if (p === `/event/${RECORDED_EVENT}/open_edits`) return html(recorded('event-open-edits.html'));

    // Desde acá hace falta sesión.
    const needsLogin = new RegExp(`^/event/(create|${GUID}(/(edits|open_edits|add-event-art|event-art))?)$|^/ws/js/`);
    if (needsLogin.test(p)) {
      if (this.sessionExpiresOnNextForm && p === '/event/create') {
        this.sessionExpiresOnNextForm = false;
        this.loggedIn = false;
      }
      if (!this.loggedIn) return redirect(`${AUTH}/login?next=%2Foauth2%2Fauthorize`);
    }

    if (p === '/event/create') {
      if (method === 'POST') return this.submitEvent(url, bodyText, html, redirect);
      return html(this.eventForm(url));
    }
    if ((m = p.match(new RegExp(`^/event/(${GUID})$`)))) return html(this.eventPage(m[1]), this.created.has(m[1]) ? 200 : 404);
    if ((m = p.match(new RegExp(`^/event/(${GUID})/edits$`)))) return html(this.editsPage(this.eventEdits(m[1])));
    if ((m = p.match(new RegExp(`^/event/(${GUID})/open_edits$`)))) return html(this.editsPage(this.openEdits.get(m[1]) ?? []));
    if ((m = p.match(new RegExp(`^/event/(${GUID})/add-event-art$`)))) return html(this.artForm(m[1], url));
    if (new RegExp(`^/event/${GUID}/event-art$`).test(p)) return html(page('<div id="content"><h1>Event art</h1></div>'));
    if ((m = p.match(new RegExp(`^/ws/js/event-art-upload/(${GUID})$`)))) return this.upload(m[1], bodyText, res);

    return html('not found', 404);
  }

  home() {
    const header = this.loggedIn
      ? `<ul class="menu"><li class="account" tabindex="-1"><span class="menu-header">${esc(this.displayName)}&nbsp;▾</span></li></ul>`
      : '<ul class="menu"><li><a href="/login">Log in</a></li></ul>';
    return page('<div id="content"><h1>MusicBrainz</h1></div>', header);
  }

  // ---- crear evento -------------------------------------------------------

  eventForm(url, extraErrors = []) {
    const params = [...url.searchParams];
    const omit = new Set(this.behavior.omitFields);
    const rows = [];
    for (const [key, value] of params) {
      if (!key.startsWith('edit-event.') || key.includes('.url.') || omit.has(key)) continue;
      if (key === 'edit-event.edit_note') continue;
      if (key === 'edit-event.type_id') {
        const options = [1, 2, 3].map((i) => `<option value="${i}"${String(i) === value ? ' selected' : ''}>type ${i}</option>`);
        rows.push(`<div class="row"><select name="${key}"><option value="">-</option>${options.join('')}</select></div>`);
      } else {
        rows.push(`<div class="row"><input type="text" name="${key}" id="id-${key}" value="${esc(value)}"></div>`);
      }
    }
    if (!omit.has('edit-event.name') && !params.some(([k]) => k === 'edit-event.name')) {
      rows.push('<div class="row"><input type="text" name="edit-event.name" value=""></div>');
    }

    const rels = {};
    for (const [key, value] of params) {
      const m = key.match(/^rels\.(\d+)\.(type|target)$/);
      if (m) (rels[m[1]] ??= {})[m[2]] = value;
    }
    const relItems = Object.keys(rels).sort().map((i) => {
      const { type, target } = rels[i];
      if (!new RegExp(`^${GUID}$`, 'i').test(target ?? '')) {
        return `<div class="relationship-item"><span class="rel-add"><span class="no-value">${esc(target ?? 'no entity')}</span></span></div><p class="error">You must select a relationship type and target entity for every relationship.</p>`;
      }
      const kind = type === LINK_TYPES.heldAt ? 'place' : 'artist';
      return `<div class="relationship-item"><span class="rel-add"><a class="wrap-anywhere" href="/${kind}/${target}" target="_blank"><bdi>${kind} ${target.slice(0, 4)}</bdi></a></span></div>`;
    });

    const urls = {};
    for (const [key, value] of params) {
      const m = key.match(/^edit-event\.url\.(\d+)\.text$/);
      if (m) urls[m[1]] = value;
    }
    const linkRows = Object.keys(urls).sort().map((i) => `<tr class="external-link-item"><td><input class="value with-button" type="text" value="${esc(urls[i])}"></td></tr>`);
    linkRows.push('<tr class="external-link-item"><td><input class="value with-button" type="text" value=""></td></tr>');

    const note = params.find(([k]) => k === 'edit-event.edit_note')?.[1] ?? '';
    const errors = [...this.behavior.formErrors, ...extraErrors];
    return page(`<div id="content"><h1>Add event</h1>
      <form class="edit-event" method="post">
        ${rows.join('\n')}
        ${errors.length ? `<ul class="errors">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        <fieldset id="relationship-editor"><div class="relationship-editor-fieldset-content">${relItems.join('')}</div></fieldset>
        <table class="row-form" id="external-links-editor"><tbody>${linkRows.join('')}</tbody></table>
        <fieldset class="editnote"><textarea class="edit-note" name="edit-event.edit_note">${esc(note)}</textarea></fieldset>
        <div class="row no-label buttons"><button class="submit positive" type="submit">Enter edit</button></div>
      </form></div>`);
  }

  submitEvent(url, body, html, redirect) {
    this.posts.push({ search: url.search, body, at: Date.now() });
    const mode = this.behavior.submit;
    if (mode === 'validation_error') return html(this.eventForm(url, ['Required field.']));
    if (mode === 'no_redirect') return html(page('<div id="content"><h1>Service unavailable</h1></div>'));
    const mbid = `00000000-0000-4000-8000-${String(this.created.size + 1).padStart(12, '0')}`;
    this.created.set(mbid, { search: url.search, name: url.searchParams.get('edit-event.name') });
    return redirect(`${MB}/event/${mbid}`);
  }

  eventPage(mbid) {
    const event = this.created.get(mbid);
    if (!event) return page('<div id="content"><h1>Not found</h1></div>');
    const params = new URLSearchParams(event.search);
    const drop = new Set(this.behavior.dropFromEventPage);
    const links = [];
    for (const [key, value] of params) {
      if (/^rels\.\d+\.target$/.test(key) && !drop.has(value)) links.push(`<a href="/artist/${value}"><bdi>x</bdi></a>`);
      if (/^edit-event\.url\.\d+\.text$/.test(key) && !drop.has(value)) links.push(`<a href="${esc(value)}">${esc(value)}</a>`);
    }
    return page(`<div id="content"><div class="eventheader"><h1><a href="/event/${mbid}"><bdi>${esc(event.name)}</bdi></a> (2026-12-14)</h1></div>
      <table class="details"><tbody><tr><td>${links.join('<br/>')}</td></tr></tbody></table></div><div id="sidebar"></div>`);
  }

  eventEdits(mbid) {
    if (!this.created.has(mbid)) return [];
    return [
      { id: 5001, editor: this.username },
      { id: 5002, editor: this.username },
      { id: 5003, editor: 'someone_else' }, // una edición ajena en la misma entidad
    ];
  }

  editsPage(edits) {
    const blocks = edits.map(({ id, editor }) => `<div class="edit-list"><div class="edit-header applied edit-add">
      <h2><a href="/edit/${id}"><bdi>Edit #${id} - Add relationship</bdi></a></h2>
      <p class="subheader"><span class="prefix">~</span> Edit by <a href="/user/${encodeURIComponent(editor)}"><bdi>${esc(editor)}</bdi></a></p></div></div>`);
    return page(`<div id="content"><h1>Edits</h1><div id="edits"><form action="/edit/enter_votes" method="post">${blocks.join('')}</form></div></div>`);
  }

  // ---- add event art ------------------------------------------------------

  artForm(mbid, url) {
    const note = url.searchParams.get('add-event-art.edit_note') ?? '';
    const warning = this.behavior.archiveWarning
      ? '<div><div class="eaa-warning">The Internet Archive is currently experiencing difficulties.</div></div>'
      : '<div style="display:none"><div class="eaa-warning">warning</div></div>';
    return page(`<div id="content"><h2>Add event art</h2>
      ${warning}
      <form id="add-event-art" class="event-art" action="/event/${mbid}/add-event-art" method="post">
        <input style="position:absolute;top:0;left:-1000px" class="add-files" accept="image/png,image/jpeg,image/gif" type="file" name="files[]" multiple="multiple">
        <div id="rows"></div>
        <fieldset class="editnote"><textarea class="edit-note" name="add-event-art.edit_note">${esc(note)}</textarea></fieldset>
        <div class="row no-label buttons"><button id="add-event-art-submit" type="submit" disabled="disabled" class="submit positive">Enter edit</button></div>
      </form></div>
      <script>
        // Imita lo que hace edit/MB/Art.js al elegir el archivo y al enviar.
        const input = document.querySelector('input.add-files');
        const submit = document.getElementById('add-event-art-submit');
        input.addEventListener('change', () => {
          document.getElementById('rows').innerHTML =
            '<ul class="event-art-type-checkboxes"><li><label><input type="checkbox" class="type" value="1"><span>Poster</span></label></li>' +
            '<li><label><input type="checkbox" class="type" value="2"><span>Other</span></label></li></ul><span class="msg">&nbsp;</span>';
          submit.disabled = false;
        });
        submit.addEventListener('click', async (event) => {
          event.preventDefault();
          const types = [...document.querySelectorAll('input.type:checked')].map((i) => i.nextElementSibling.textContent);
          const file = input.files[0];
          const res = await fetch('/ws/js/event-art-upload/${mbid}', { method: 'POST', body: JSON.stringify({ types, name: file.name, size: file.size }) });
          const text = await res.text();
          if (res.ok) { location.href = '/event/${mbid}/event-art'; return; }
          document.getElementById('rows').insertAdjacentHTML('beforeend', '<span class="msg error">' + text + '</span>');
        });
      </script>`);
  }

  upload(mbid, body, res) {
    this.uploads.push({ mbid, body: JSON.parse(body || '{}') });
    const mode = this.behavior.art;
    if (mode === 'hang') return; // nunca responde
    const reply = (status, text) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    if (mode === 'upload_error') return reply(500, '⚠ Error uploading image');
    if (mode === 'submit_error') return reply(500, '⚠ Error creating edit');
    const list = this.openEdits.get(mbid) ?? [];
    this.nextEdit += 1;
    list.push({ id: this.nextEdit, editor: this.username });
    this.openEdits.set(mbid, list);
    return reply(200, 'ok');
  }
}
