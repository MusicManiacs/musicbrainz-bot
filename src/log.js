// Logger en JSON por línea. Todo lo que se escribe pasa por un filtro que
// reemplaza los secretos conocidos (contraseña, token), aunque aparezcan
// dentro de un mensaje de error de Playwright.

export function createLogger({ secrets = [], out = process.stdout } = {}) {
  const needles = [];
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    needles.push(secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret));
  }

  const redact = (line) => needles.reduce((acc, n) => acc.split(n).join('[REDACTED]'), line);

  const write = (level, msg, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    out.write(`${redact(line)}\n`);
  };

  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
