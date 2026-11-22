import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9-]+$/;

// Capturas de pantalla de cada ejecución (antes y después de enviar), para
// poder explicar cualquier edición del bot. Se sirven por GET /captures/:id.
export class Captures {
  constructor(dir, ttlDays) {
    this.dir = path.resolve(dir, 'captures');
    this.ttlMs = ttlDays * 24 * 3600 * 1000;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await this.purge();
  }

  newRun() {
    return randomUUID();
  }

  async take(page, runId, label) {
    const id = `${runId}-${label}`;
    await fs.writeFile(path.join(this.dir, `${id}.png`), await page.screenshot({ fullPage: true }));
    return { label, id, url: `/captures/${id}` };
  }

  // Devuelve la ruta del archivo, o null si el id no es válido o no existe.
  async file(id) {
    if (!ID.test(id)) return null;
    const file = path.join(this.dir, `${id}.png`);
    try {
      await fs.access(file);
      return file;
    } catch {
      return null;
    }
  }

  async purge(now = Date.now()) {
    if (this.ttlMs <= 0) return;
    for (const name of await fs.readdir(this.dir)) {
      const file = path.join(this.dir, name);
      const { mtimeMs } = await fs.stat(file);
      if (now - mtimeMs > this.ttlMs) await fs.rm(file, { force: true });
    }
  }
}
