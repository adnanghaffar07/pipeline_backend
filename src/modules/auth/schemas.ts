import { z } from 'zod';
import { userViewSchema } from '../me/view.js';

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

const password = z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password must be at most 72 characters');
const challengeId = z.string().min(1).max(64);

export const registerBody = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(100),
  email: emailField,
  countryName: z.string().trim().min(1, 'Country is required').max(100),
  dialCode: z.string().trim().regex(/^\+\d{1,4}$/, 'Dial code must look like +92'),
  mobile: z.string().trim().min(4, 'Enter a valid mobile number').max(20),
  password,
  termsAccepted: z.literal(true, { message: 'You must accept the terms' }),
});

export const loginBody = z.object({
  email: emailField,
  password: z.string().min(1).max(72),
});

export const verifyBody = z.object({
  challengeId,
  code: z.string().regex(/^\d{4}$/, 'Code must be 4 digits'),
});

export const resendBody = z.object({ challengeId });

export const refreshBody = z.object({ refreshToken: z.string().min(1).max(512) });

export const forgotBody = z.object({ email: emailField });

export const resetBody = verifyBody.extend({ newPassword: password });

export const oauthParams = z.object({ provider: z.enum(['google', 'microsoft']) });
export const oauthBody = z.object({ idToken: z.string().min(1).max(8192), nonce: z.string().max(512).optional() });

export const challengeResponse = z.object({
  challengeId: z.string(),
  channel: z.enum(['email', 'sms']),
  destinationMasked: z.string(),
  resendAvailableInSec: z.number().int(),
});

export const tokenResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  isNewUser: z.boolean(),
  user: userViewSchema,
});

export const loginResponse = z.union([
  challengeResponse.extend({ otpRequired: z.literal(true) }),
  tokenResponse.extend({ otpRequired: z.literal(false) }),
]);

export const refreshResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
});
