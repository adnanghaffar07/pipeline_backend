import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { AppError } from './errors.js';

/** Builds an E.164 number from the sign-up form's dial code and national mobile number. */
export function toE164(dialCode: string, mobile: string): string {
  const digits = mobile.replace(/[^\d]/g, '');
  const parsed = parsePhoneNumberFromString(`${dialCode.trim()}${digits.replace(/^0+/, '')}`);
  if (!parsed || !parsed.isPossible()) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed', {
      fields: { mobile: 'Enter a valid mobile number for the selected country' },
    });
  }
  return parsed.number;
}
