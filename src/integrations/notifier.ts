import type { OtpChannel, OtpPurpose } from '../db/schema.js';

export type { OtpPurpose };

export interface Notifier {
  sendOtp(input: { channel: OtpChannel; destination: string; code: string; purpose: OtpPurpose }): Promise<void>;
}
