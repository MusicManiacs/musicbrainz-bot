// Configuración del servicio. Todo viene de variables de entorno; las
// credenciales nunca tienen default ni se escriben en ningún lado.

const VERSION = '0.1.0';

function int(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env = process.env) {
  return {
    version: VERSION,
    port: int(env, 'PORT', 3000),
    // Token compartido con quien llama. Sin él el servicio no arranca.
    serviceToken: env.BOT_SERVICE_TOKEN ?? '',
    // Cuenta del bot en MusicBrainz. Sin ellas /edits y /account responden 503.
    username: env.MB_BOT_USERNAME ?? '',
    password: env.MB_BOT_PASSWORD ?? '',
    // Producción es una decisión explícita: por default sólo se acepta `test`.
    allowProduction: env.MB_ALLOW_PRODUCTION === 'true',
    userAgent:
      env.MB_USER_AGENT ??
      `MusicManiacsBot/${VERSION} (+https://github.com/MusicManiacs/musicbrainz-bot)`,
    dataDir: env.DATA_DIR ?? 'data',
    capturesTtlDays: int(env, 'CAPTURES_TTL_DAYS', 14),
    // Pausa mínima entre dos envíos (clicks en "Enter edit"), en ms.
    pauseBetweenSubmitsMs: int(env, 'PAUSE_BETWEEN_SUBMITS_MS', 5000),
    navigationTimeoutMs: int(env, 'NAVIGATION_TIMEOUT_MS', 30000),
    submitTimeoutMs: int(env, 'SUBMIT_TIMEOUT_MS', 60000),
    // Mínimo entre dos navegaciones a MusicBrainz (la regla del sitio: ~1 pedido por segundo).
    navIntervalMs: int(env, 'NAV_INTERVAL_MS', 1000),
    imageMaxBytes: int(env, 'IMAGE_MAX_BYTES', 20 * 1024 * 1024),
    // Playwright lanza Chromium sin sandbox por default (lo habitual en contenedores).
    chromiumSandbox: env.CHROMIUM_SANDBOX === 'true',
    loginTimeoutMs: int(env, 'LOGIN_TIMEOUT_MS', 20000),
    // Pasado este tiempo, la próxima corrida vuelve a loguearse aunque la sesión siga viva.
    loginMaxAgeHours: int(env, 'LOGIN_MAX_AGE_HOURS', 12),
    host: env.HOST ?? '0.0.0.0',
  };
}

export function isConfiguredForMusicBrainz(config) {
  return Boolean(config.username && config.password);
}
