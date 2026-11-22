import { Captures } from './captures.js';
import { isConfiguredForMusicBrainz, loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import { createLogger } from './log.js';
import { BotService } from './service.js';

const config = loadConfig();
const log = createLogger({ secrets: [config.password, config.serviceToken] });

if (!config.serviceToken) {
  log.error('BOT_SERVICE_TOKEN is not set; refusing to start');
  process.exit(1);
}
if (!isConfiguredForMusicBrainz(config)) {
  log.warn('MB_BOT_USERNAME / MB_BOT_PASSWORD are not set: /edits and /account will answer 503');
}

const captures = new Captures(config.dataDir, config.capturesTtlDays);
await captures.init();
const service = new BotService({ config, log, captures });
const server = createHttpServer({ service, captures, config, log });

server.listen(config.port, config.host, () => {
  log.info('musicbrainz-bot listening', { port: config.port, version: config.version, production_allowed: config.allowProduction });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info('shutting down', { signal });
    server.close();
    await service.close();
    process.exit(0);
  });
}
