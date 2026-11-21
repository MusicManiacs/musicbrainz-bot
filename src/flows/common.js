import { editIdsFor } from '../checks.js';
import { snapshotEdits } from '../snapshots.js';

// Respuestas de POST /edits. Invariante: `invalid` = no se envió nada;
// `uncertain` = se clickeó "Enter edit" y no se sabe si la edición quedó creada.
export function makeResults(captures) {
  const base = (status, extra) => ({
    status,
    mbid: null,
    edit_ids: [],
    candidates: [],
    captures,
    error: null,
    verification: null,
    warnings: [],
    ...extra,
  });
  const failure = (status) => (code, message, problems = []) =>
    base(status, { error: { code, message, problems } });
  return { created: (extra) => base('created', extra), invalid: failure('invalid'), uncertain: failure('uncertain') };
}

// IDs de las ediciones de la cuenta del bot en la página de ediciones de una entidad.
export async function editIdsOn(session, path) {
  await session.goto(`${session.server.mb}${path}`);
  return editIdsFor(await snapshotEdits(session.page), session.config.username);
}

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
