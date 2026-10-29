import { Resend } from 'resend';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { OtpChannel, OtpPurpose } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export type { OtpPurpose };

export interface Notifier {
  sendOtp(input: { channel: OtpChannel; destination: string; code: string; purpose: OtpPurpose }): Promise<void>;
}

const COPY: Record<OtpPurpose, { subject: string; intro: string }> = {
  signup: { subject: 'Your Pipeline verification code', intro: 'Welcome to Pipeline. Use this code to verify your email address:' },
  login: { subject: 'Your Pipeline verification code', intro: 'Use this code to finish signing in to Pipeline:' },
  password_reset: { subject: 'Reset your Pipeline password', intro: 'Use this code to reset your Pipeline password:' },
};

function renderOtpEmail(code: string, purpose: OtpPurpose) {
  const { subject, intro } = COPY[purpose];
  const outro = 'This code expires in 5 minutes. If you did not request it, you can ignore this email.';
  const text = `${intro}\n\n${code}\n\n${outro}`;
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
<p>${intro}</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:24px 0">${code}</p>
<p style="color:#555;font-size:14px">${outro}</p>
<p style="color:#999;font-size:12px">Pipeline Publishing, LLC</p>
</body></html>`;
  return { subject, text, html };
}

function requireEmail(channel: OtpChannel) {
  if (channel !== 'email') throw new Error('SMS channel not configured');
}

export class ResendNotifier implements Notifier {
  constructor(
    private readonly client: Pick<Resend, 'emails'>,
    private readonly from: string,
  ) {}

  async sendOtp({ channel, destination, code, purpose }: Parameters<Notifier['sendOtp']>[0]): Promise<void> {
    requireEmail(channel);
    const { subject, text, html } = renderOtpEmail(code, purpose);
    let error: unknown;
    try {
      ({ error } = await this.client.emails.send({ from: this.from, to: [destination], subject, text, html }));
    } catch (err) {
      error = err;
    }
    if (error) {
      throw new AppError('EMAIL_DELIVERY_FAILED', 'We could not send the email. Please try again shortly.', {}, { cause: error });
    }
  }
}

/** Development only (rejected in production by config): writes the code to the log instead of emailing it. */
export class ConsoleNotifier implements Notifier {
  constructor(private readonly log: Pick<FastifyBaseLogger, 'warn'>) {}

  async sendOtp({ channel, destination, code, purpose }: Parameters<Notifier['sendOtp']>[0]): Promise<void> {
    requireEmail(channel);
    // Deliberately not under a redacted key: printing the code is this notifier's purpose.
    this.log.warn(`[dev notifier] ${purpose} code for ${destination}: ${code}`);
  }
}

export function createNotifier(config: Config, log: Pick<FastifyBaseLogger, 'warn'>): Notifier {
  if (config.notifier === 'console') return new ConsoleNotifier(log);
  return new ResendNotifier(new Resend(config.resendApiKey), config.emailFrom);
}
