import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

const STATUS = {
  BAD_REQUEST: 400,
  OTP_INVALID: 400,
  WRONG_CHALLENGE: 400,
  INVALID_TOPICS: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_REFRESH_TOKEN: 401,
  ACCOUNT_NOT_VERIFIED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CHALLENGE_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  EMAIL_TAKEN: 409,
  OTP_ALREADY_USED: 409,
  OTP_EXPIRED: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  OTP_LOCKED: 423,
  RATE_LIMITED: 429,
  OTP_RESEND_TOO_SOON: 429,
  OTP_RATE_LIMITED: 429,
  INTERNAL: 500,
  EMAIL_DELIVERY_FAILED: 503,
  AUTH_PROVIDER_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof STATUS;

export interface ErrorExtra {
  fields?: Record<string, string>;
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: ErrorExtra = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS[code];
  }
}

/** Maps framework-level 4xx errors (bad JSON, oversized body, ...) onto our codes by status. */
const GENERIC_BY_STATUS: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

function send(reply: FastifyReply, status: number, code: string, message: string, extra: ErrorExtra = {}) {
  return reply.status(status).send({ error: { code, message, ...extra } });
}

export function errorHandler(err: FastifyError | AppError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) req.log.error({ err }, err.message);
    if (err.code === 'RATE_LIMITED' && typeof err.extra.retryAfterSec === 'number') {
      reply.header('retry-after', String(err.extra.retryAfterSec));
    }
    return send(reply, err.statusCode, err.code, err.message, err.extra);
  }

  if (hasZodFastifySchemaValidationErrors(err)) {
    const fields: Record<string, string> = {};
    for (const issue of err.validation) {
      const path = issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || '_';
      fields[path] ??= issue.message ?? 'Invalid value';
    }
    return send(reply, 422, 'VALIDATION_FAILED', 'Request validation failed', { fields });
  }

  const status = err.statusCode ?? 500;
  const code = GENERIC_BY_STATUS[status];
  if (status < 500 && code) {
    return send(reply, status, code, err.message);
  }

  req.log.error({ err }, 'Unhandled error');
  return send(reply, 500, 'INTERNAL', 'Internal server error');
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  return send(reply, 404, 'NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`);
}
