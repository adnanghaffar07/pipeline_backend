import { describe, expect, it } from 'vitest';
import { maskEmail, normalizeEmail } from '../../src/lib/email.js';
import { toE164 } from '../../src/lib/phone.js';

describe('email helpers', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeEmail('  A@B.COM ')).toBe('a@b.com');
  });

  it('masks the local part', () => {
    expect(maskEmail('adnan@example.com')).toBe('a***n@example.com');
    expect(maskEmail('ab@example.com')).toBe('a***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });
});

describe('toE164', () => {
  it('combines dial code and mobile', () => {
    expect(toE164('+92', '3001234567')).toBe('+923001234567');
    expect(toE164('+1', '(415) 555-2671')).toBe('+14155552671');
  });

  it('drops a national trunk zero', () => {
    expect(toE164('+44', '07911 123456')).toBe('+447911123456');
  });

  it('rejects an invalid number with VALIDATION_FAILED on mobile', () => {
    expect(() => toE164('+92', '12')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', extra: { fields: { mobile: expect.any(String) } } }));
  });
});
