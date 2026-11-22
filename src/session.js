// Sesión de la cuenta del bot en un servidor de MusicBrainz: un contexto de
// Chromium propio, el login con usuario y contraseña en metabrainz.org, y
// "volver a loguearse" cuando la sesión vence.

export class LoginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Garantiza un mínimo entre dos navegaciones a MusicBrainz (~1 pedido por segundo).
export class Throttle {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.nextAt = 0;
  }

  async wait() {
    const delay = this.nextAt - Date.now();
    if (delay > 0) await sleep(delay);
    this.nextAt = Date.now() + this.intervalMs;
  }
}

export class Session {
  constructor({ browser, server, config, log, throttle, userAgent }) {
    this.browser = browser;
    this.server = server;
    this.config = config;
    this.log = log;
    this.throttle = throttle;
    this.userAgent = userAgent;
    this.page = null;
    this.loggedInAt = null;
  }

  get loggedIn() {
    return this.loggedInAt !== null;
  }

  async open() {
    this.context = await this.browser.newContext({
      locale: 'en-US',
      userAgent: this.userAgent,
      viewport: { width: 1280, height: 1000 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.navigationTimeoutMs);
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.page = null;
    this.loggedInAt = null;
  }

  async navigate(url) {
    await this.throttle.wait();
    return this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs });
  }

  isLoginRedirect() {
    const u = new URL(this.page.url());
    return u.origin === this.server.auth || (u.origin === this.server.mb && u.pathname === '/login');
  }

  // Nombre de la cuenta con sesión iniciada, leído del menú de la cabecera.
  async accountName() {
    const text = await this.page
      .locator('li.account > span.menu-header')
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);
    return text ? text.replace(/[\s\u00a0]*▾\s*$/u, '').trim() : null;
  }

  async login() {
    const { page, server, config } = this;
    this.loggedInAt = null;
    this.log.info('logging in', { server: server.name });

    await this.navigate(`${server.mb}/login`);
    if (this.isLoginRedirect()) {
      await page.locator('#username').fill(config.username);
      await page.locator('#password').fill(config.password);
      await page.locator('form button[type="submit"]').click();
      const back = await page
        .waitForURL((u) => u.origin === server.mb, { timeout: config.loginTimeoutMs, waitUntil: 'domcontentloaded' })
        .then(() => true, () => false);
      if (!back) {
        throw new LoginError('login_failed', 'MusicBrainz did not accept the bot credentials (or the login did not complete)');
      }
    }

    await this.navigate(`${server.mb}/`);
    const name = await this.accountName();
    if (!name) throw new LoginError('login_failed', 'the account menu was not found after logging in');
    if (name.toLowerCase() !== config.username.toLowerCase()) {
      throw new LoginError('account_mismatch', `logged in as "${name}", but MB_BOT_USERNAME is "${config.username}"`);
    }
    this.loggedInAt = Date.now();
    this.log.info('logged in', { server: server.name, account: name });
  }

  async ensure() {
    const maxAgeMs = this.config.loginMaxAgeHours * 3600 * 1000;
    if (!this.loggedIn || (maxAgeMs > 0 && Date.now() - this.loggedInAt > maxAgeMs)) await this.login();
  }

  // Abre una URL de MusicBrainz con la sesión; si la sesión venció, se loguea y reintenta una vez.
  async goto(url) {
    await this.ensure();
    await this.navigate(url);
    if (!this.isLoginRedirect()) return;
    this.log.warn('session expired, logging in again', { server: this.server.name });
    await this.login();
    await this.navigate(url);
    if (this.isLoginRedirect()) throw new LoginError('login_failed', 'MusicBrainz keeps redirecting to the login page');
  }
}
