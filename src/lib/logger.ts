import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Writable } from 'node:stream';
import type { FastifyServerOptions } from 'fastify';
import { stdSerializers } from 'pino';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Config } from '../config.js';

const SECRET_KEYS = ['password', 'newPassword', 'codeHash', 'code_hash', 'refreshToken', 'accessToken', 'idToken', 'token'];

/**
 * Covers secrets at the top level and up to three levels deep (e.g. `body.password`, `err.meta.token`).
 * `code` is only secret inside a request body (the OTP); elsewhere it is an error code we want to see.
 */
const REDACT_PATHS = [
  ...['authorization', 'cookie', '["set-cookie"]'].flatMap((h) => [`headers.${h}`, `*.headers.${h}`]),
  'body.code',
  '*.body.code',
  ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
];

type SerializedError = ReturnType<typeof stdSerializers.err> & Record<string, unknown>;

/**
 * Drizzle's query errors carry the bound parameters (emails, phone numbers, code hashes) in both
 * `message` and `params`, and Postgres puts row values in `detail`. Keep the SQL, drop the values.
 */
function serializeError(err: Error): SerializedError {
  const out = stdSerializers.err(err) as SerializedError;
  if (err instanceof DrizzleQueryError) {
    out.message = `Failed query: ${err.query}`;
    out.stack = `${out.message}\n${(err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).join('\n')}`;
    delete out.params;
  }
  const cause = out.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === 'object') {
    for (const k of ['detail', 'params', 'parameters', 'queryOptions']) delete cause[k];
  }
  return out;
}

export function loggerOptions(config: Config, stream?: Writable): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { err: serializeError },
    ...(stream ? { stream } : {}),
  };
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Trust a caller-supplied x-request-id only when it is short and plain; otherwise mint one. */
export function genReqId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}
