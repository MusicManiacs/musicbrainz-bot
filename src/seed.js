// Lee la URL precargada de un form de MusicBrainz y la convierte en lo que el
// bot espera encontrar en la página. MusicBrainz precarga los forms con query
// params (`edit-event.name=...`, `rels.0.type=...&rels.0.target=<mbid>`,
// `edit-event.url.0.text=...`); la URL es la única fuente de verdad.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isGuid = (value) => GUID.test(value ?? '');

const byIndex = (a, b) => Number(a) - Number(b);

export function parseSeed(url, formName) {
  const fields = {};
  const rels = {};
  const urls = {};
  const problems = [];
  const seen = new Set();
  const urlKey = new RegExp(`^${formName}\\.url\\.(\\d+)\\.(text|link_type_id)$`);

  for (const [key, value] of url.searchParams) {
    // MusicBrainz rechaza un campo repetido ("field must contain a single value").
    if (seen.has(key)) problems.push(`seeded parameter "${key}" is repeated`);
    seen.add(key);

    let m;
    if ((m = key.match(/^rels\.(\d+)\.(type|target)$/))) {
      (rels[m[1]] ??= {})[m[2]] = value.trim();
    } else if ((m = key.match(urlKey))) {
      (urls[m[1]] ??= {})[m[2]] = value.trim();
    } else if (key.startsWith(`${formName}.`)) {
      fields[key] = value;
    }
  }

  const relList = Object.keys(rels).sort(byIndex).map((i) => ({
    type: rels[i].type ?? null,
    target: rels[i].target ?? null,
  }));
  relList.forEach((rel, i) => {
    // Un target que no es un MBID es texto: el editor lo muestra sin entidad.
    if (!isGuid(rel.target)) problems.push(`relationship ${i} does not point to an entity (target is not an MBID)`);
    if (!rel.type) problems.push(`relationship ${i} has no type`);
  });

  const urlList = Object.keys(urls).sort(byIndex).map((i) => urls[i].text ?? '');
  urlList.forEach((text, i) => {
    if (!text) problems.push(`external link ${i} has no URL`);
  });

  return { fields, rels: relList, urls: urlList, problems };
}

// Compara URLs sin importar esquema, `www.`, barra final ni fragmento: MusicBrainz
// limpia algunos links al cargarlos (p. ej. agrega `www.` o saca la barra).
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  try {
    const u = new URL(text);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return text.toLowerCase();
  }
}
