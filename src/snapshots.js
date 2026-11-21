// Lectura del DOM de MusicBrainz. Estas funciones sólo EXTRAEN datos de la
// página (corren dentro del navegador); las decisiones se toman en checks.js,
// que es código puro y se prueba aparte.

export function snapshotEventForm(page) {
  return page.evaluate(() => {
    const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const form = document.querySelector('form.edit-event');
    if (!form) return { hasForm: false };

    const fields = {};
    for (const el of form.querySelectorAll('input[name], select[name], textarea[name]')) {
      fields[el.name] = { type: el.type, value: el.value, checked: el.checked };
    }

    const relationships = [...form.querySelectorAll('#relationship-editor .relationship-item')].map((item) => ({
      hrefs: [...item.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      removed: Boolean(item.querySelector('.rel-remove')),
      text: text(item).slice(0, 160),
    }));

    const links = [...form.querySelectorAll('#external-links-editor tr.external-link-item')].map((row) => ({
      value: row.querySelector('input.value')?.value ?? '',
      errors: [...row.querySelectorAll('.field-error')].map(text).filter(Boolean),
    }));

    const errors = [
      ...form.querySelectorAll('ul.errors li, .field-error, #relationship-editor p.error, #relationship-editor strong.error'),
    ]
      .filter((el) => !el.closest('#external-links-editor'))
      .map(text)
      .filter(Boolean);

    return {
      hasForm: true,
      fields,
      relationships,
      links,
      errors,
      editNote: form.querySelector('textarea.edit-note')?.value ?? null,
      submits: [...form.querySelectorAll('button.submit.positive')].map((b) => ({ disabled: b.disabled })),
    };
  });
}

export function snapshotEventPage(page) {
  return page.evaluate(() => ({
    title: document.querySelector('#content h1 bdi')?.textContent?.trim() ?? null,
    hrefs: [...document.querySelectorAll('#content a[href], #sidebar a[href]')].map((a) => a.getAttribute('href')),
  }));
}

export function snapshotEdits(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.edit-list')].map((el) => {
      const link = el.querySelector('h2 a[href^="/edit/"]');
      const id = link?.getAttribute('href')?.match(/^\/edit\/(\d+)/)?.[1] ?? null;
      const editorHref = el.querySelector('p.subheader a[href^="/user/"]')?.getAttribute('href') ?? null;
      const editor = editorHref ? decodeURIComponent(editorHref.replace(/^\/user\//, '').split(/[/?#]/)[0]) : null;
      return { id, editor, title: link?.textContent?.trim() ?? null };
    }),
  );
}

export function snapshotUserProfile(page) {
  return page.evaluate(() => ({
    types: [...document.querySelectorAll('table.profileinfo a[href^="/doc/Editor#"]')].map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent.trim(),
    })),
  }));
}

export function snapshotArtForm(page) {
  return page.evaluate(() => {
    const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const form = document.querySelector('form#add-event-art');
    if (!form) return { hasForm: false };
    const submit = form.querySelector('#add-event-art-submit');
    const note = form.querySelector('textarea.edit-note');
    return {
      hasForm: true,
      hasFileInput: Boolean(form.querySelector('input.add-files[type="file"]')),
      submit: submit ? { disabled: submit.disabled } : null,
      editNote: note?.value ?? null,
      editNoteName: note?.name ?? null,
      archiveWarning: [...document.querySelectorAll('.eaa-warning')].some(visible),
    };
  });
}

export function snapshotArtUpload(page) {
  return page.evaluate(() => {
    const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      types: [...document.querySelectorAll('.event-art-type-checkboxes label')]
        .filter(visible)
        .map((label) => ({ label: text(label), checked: Boolean(label.querySelector('input.type')?.checked) })),
      errors: [...document.querySelectorAll('span.msg.error')].filter(visible).map(text),
    };
  });
}
