import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

import { RequestError } from './servers.js';

const MAX_BODY = 64 * 1024;
const digest = (value) => createHash('sha256').update(value).digest();

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

const errorBody = (code, message) => ({ error: { code, message } });

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RequestError('body_too_large', 'the request body is too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('invalid_body', 'the body is not valid JSON');
  }
}

export function createHttpServer({ service, captures, config, log }) {
  const expected = digest(config.serviceToken);
  const authorized = (req) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return Boolean(match) && timingSafeEqual(digest(match[1]), expected);
  };

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    let status = 500;
    const reply = (code, body) => {
      status = code;
      send(res, code, body);
    };

    try {
      if (req.method === 'GET' && pathname === '/health') {
        reply(200, service.health());
      } else if (!authorized(req)) {
        reply(401, errorBody('unauthorized', 'missing or invalid bearer token'));
      } else if (req.method === 'GET' && pathname === '/account') {
        reply(200, await service.account(searchParams.get('server') ?? 'test'));
      } else if (req.method === 'POST' && pathname === '/edits') {
        reply(200, await service.createEdit(await readJson(req)));
      } else if (req.method === 'GET' && pathname.startsWith('/captures/')) {
        const file = await captures.file(pathname.slice('/captures/'.length));
        if (!file) {
          reply(404, errorBody('not_found', 'capture not found'));
        } else {
          status = 200;
          res.writeHead(200, { 'content-type': 'image/png' });
          fs.createReadStream(file).pipe(res);
        }
      } else {
        reply(404, errorBody('not_found', 'no such endpoint'));
      }
    } catch (error) {
      if (error instanceof RequestError) {
        reply(error.httpStatus, errorBody(error.code, error.message));
      } else {
        log.error('unhandled error', { path: pathname, error: error.message });
        reply(500, errorBody('internal_error', 'unexpected error'));
      }
    } finally {
      log.info('request', { method: req.method, path: pathname.startsWith('/captures/') ? '/captures/:id' : pathname, status, ms: Date.now() - started });
    }
  });
}
