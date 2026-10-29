import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Writable } from 'node:stream';
import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config.js';

const SECRET_KEYS = ['password', 'newPassword', 'code', 'codeHash', 'refreshToken', 'accessToken', 'idToken', 'token'];

/** Covers secrets at the top level and up to three levels deep (e.g. `body.password`, `err.meta.token`). */
const REDACT_PATHS = [
  ...['authorization', 'cookie', '["set-cookie"]'].flatMap((h) => [`headers.${h}`, `*.headers.${h}`]),
  ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
];

export function loggerOptions(config: Config, stream?: Writable): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(stream ? { stream } : {}),
  };
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Trust a caller-supplied x-request-id only when it is short and plain; otherwise mint one. */
export function genReqId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}
