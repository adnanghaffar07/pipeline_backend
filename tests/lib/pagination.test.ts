import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, listEnvelope } from '../../src/lib/pagination.js';
import { AppError } from '../../src/lib/errors.js';

describe('pagination', () => {
  it('round-trips a cursor', () => {
    const c = encodeCursor({ id: 42, at: '2026-10-29T00:00:00.000Z' });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual({ id: 42, at: '2026-10-29T00:00:00.000Z' });
  });

  it('rejects a malformed cursor with VALIDATION_FAILED', () => {
    for (const bad of ['%%%', 'bm90LWpzb24', encodeURIComponent('[]')]) {
      try {
        decodeCursor(bad);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('VALIDATION_FAILED');
      }
    }
  });

  it('builds the list envelope', () => {
    expect(listEnvelope([1, 2], null, 2)).toEqual({ items: [1, 2], nextCursor: null, total: 2 });
  });
});
