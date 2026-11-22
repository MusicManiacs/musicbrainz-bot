import { chromium } from 'playwright';

import { isBotAccount } from './checks.js';
import { isConfiguredForMusicBrainz } from './config.js';
import { addEventArt } from './flows/event-art.js';
import { createEvent } from './flows/event.js';
import { RequestError, resolveServer, validateFormUrl } from './servers.js';
import { Session, Throttle } from './session.js';
import { snapshotUserProfile } from './snapshots.js';

const KINDS = ['event', 'place', 'artist', 'event_art'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchChromium(config) {
  return chromium.launch({ headless: true, chromiumSandbox: config.chromiumSandbox });
}

// Orquesta el navegador: una sesión por servidor, un solo trabajo a la vez y
// una pausa entre envíos. No conoce nada de Music Maniacs.
export class BotService {
  // `dryRun` sólo lo usa scripts/smoke.js: pasa por todos los chequeos y no envía.
  constructor({ config, log, captures, launch = launchChromium, dryRun = false }) {
    this.dryRun = dryRun;
    this.config = config;
    this.log = log;
    this.captures = captures;
    this.launch = launch;
    this.sessions = new Map();
    this.throttle = new Throttle(config.navIntervalMs);
    this.busy = false;
    this.lastSubmitAt = 0;
  }

  health() {
    return {
      status: 'ok',
      version: this.config.version,
      credentials_configured: isConfiguredForMusicBrainz(this.config),
      busy: this.busy,
      logged_in: Object.fromEntries([...this.sessions].map(([name, s]) => [name, s.loggedIn])),
    };
  }

  async exclusive(fn) {
    if (this.busy) throw new RequestError('busy', 'the bot is already handling another request', 409);
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  requireConfigured() {
    if (!isConfiguredForMusicBrainz(this.config)) {
      throw new RequestError('not_configured', 'MB_BOT_USERNAME and MB_BOT_PASSWORD are not set', 503);
    }
  }

  async session(server) {
    let session = this.sessions.get(server.name);
    if (session) return session;
    if (!this.browser) {
      this.browser = await this.launch(this.config);
      const probe = await this.browser.newContext();
      const ua = await (await probe.newPage()).evaluate(() => navigator.userAgent);
      await probe.close();
      this.userAgent = `${ua} ${this.config.userAgent}`;
    }
    session = new Session({
      browser: this.browser,
      server,
      config: this.config,
      log: this.log,
      throttle: this.throttle,
      userAgent: this.userAgent,
    });
    await session.open();
    this.sessions.set(server.name, session);
    return session;
  }

  // GET /account: verifica la sesión y si la cuenta tiene tipo Bot.
  async account(serverName) {
    const server = resolveServer(serverName, this.config);
    this.requireConfigured();
    return this.exclusive(async () => {
      const session = await this.session(server);
      const username = this.config.username;
      try {
        await session.ensure();
        await session.goto(`${server.mb}/user/${encodeURIComponent(username)}`);
        const profile = await snapshotUserProfile(session.page);
        return {
          server: server.name,
          username,
          logged_in: true,
          is_bot: isBotAccount(profile),
          user_types: profile.types.map((t) => t.text),
          error: null,
        };
      } catch (error) {
        if (!error.code) throw error;
        return { server: server.name, username, logged_in: false, is_bot: false, user_types: [], error: { code: error.code, message: error.message } };
      }
    });
  }

  // POST /edits
  async createEdit(body) {
    if (body === null || typeof body !== 'object') throw new RequestError('invalid_body', 'the body must be a JSON object');
    const { kind } = body;
    if (!KINDS.includes(kind)) throw new RequestError('invalid_kind', `"kind" must be one of ${KINDS.join(', ')}`);
    const server = resolveServer(body.server, this.config);
    if (kind === 'place' || kind === 'artist') {
      throw new RequestError('not_implemented', `kind "${kind}" is not implemented yet`, 501);
    }
    const { url, entityMbid } = validateFormUrl(server, kind, body.url);
    if (kind === 'event_art' && typeof body.image_url !== 'string') {
      throw new RequestError('invalid_image_url', '"image_url" is required for event_art');
    }
    this.requireConfigured();

    return this.exclusive(async () => {
      const runId = this.captures.newRun();
      const session = await this.session(server);
      const ctx = {
        session,
        config: this.config,
        dryRun: this.dryRun,
        capture: (page, label) =>
          this.captures.take(page, runId, label).catch((error) => {
            this.log.warn('capture failed', { label, error: error.message });
            return null;
          }),
        waitBeforeSubmit: async () => {
          const wait = this.lastSubmitAt + this.config.pauseBetweenSubmitsMs - Date.now();
          if (wait > 0) await sleep(wait);
          this.lastSubmitAt = Date.now();
        },
      };
      const result =
        kind === 'event'
          ? await createEvent(ctx, { url })
          : await addEventArt(ctx, { url, mbid: entityMbid, imageUrl: body.image_url });
      this.log.info('edit request finished', {
        kind,
        server: server.name,
        status: result.status,
        mbid: result.mbid,
        edit_ids: result.edit_ids,
        error_code: result.error?.code ?? null,
      });
      return result;
    });
  }

  async close() {
    for (const session of this.sessions.values()) await session.close();
    await this.browser?.close().catch(() => {});
  }
}
