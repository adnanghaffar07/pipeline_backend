import { AppError } from './errors.js';

export interface ListEnvelope<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string): T {
  const invalid = () => new AppError('VALIDATION_FAILED', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  return parsed as T;
}

export function listEnvelope<T>(items: T[], nextCursor: string | null, total: number): ListEnvelope<T> {
  return { items, nextCursor, total };
}
