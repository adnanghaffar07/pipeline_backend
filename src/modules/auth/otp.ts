import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { and, count, eq, gt, isNull, sum } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { otpChallenges, type OtpChannel, type OtpPurpose } from '../../db/schema.js';
import type { Notifier } from '../../integrations/notifier.js';
import { maskEmail } from '../../lib/email.js';
import { AppError } from '../../lib/errors.js';

const MAX_RESENDS = 5;
const MAX_CHALLENGES_PER_HOUR = 10;
const MAX_FAILED_ATTEMPTS_PER_DAY = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateCode(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0');
}

/** Keyed hash: a bare SHA-256 of a 4-digit code could be reversed by trying all 10,000 values. */
export function hashCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

export interface ChallengeInfo {
  challengeId: string;
  channel: OtpChannel;
  destinationMasked: string;
  resendAvailableInSec: number;
}

type Row = typeof otpChallenges.$inferSelect;

type VerifyOutcome =
  | { ok: true; row: Row }
  | { ok: false; error: AppError };

const secondsUntil = (from: Date, to: Date) => Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000));

export class OtpService {
  constructor(
    private readonly db: Db,
    private readonly notifier: Notifier,
    private readonly config: Config,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private info(row: Pick<Row, 'id' | 'channel' | 'destination'>): ChallengeInfo {
    return {
      challengeId: row.id,
      channel: row.channel,
      destinationMasked: row.channel === 'email' ? maskEmail(row.destination) : row.destination.replace(/\d(?=\d{2})/g, '*'),
      resendAvailableInSec: this.config.otpResendSeconds,
    };
  }

  private windows(now: Date) {
    return {
      expiresAt: new Date(now.getTime() + this.config.otpTtlSeconds * 1000),
      resendAvailableAt: new Date(now.getTime() + this.config.otpResendSeconds * 1000),
    };
  }

  private async find(challengeId: string): Promise<Row> {
    const notFound = new AppError('CHALLENGE_NOT_FOUND', 'Verification request not found. Please start again.');
    if (!UUID.test(challengeId)) throw notFound;
    const [row] = await this.db.select().from(otpChallenges).where(eq(otpChallenges.id, challengeId));
    if (!row) throw notFound;
    return row;
  }

  async issue(input: {
    userId: string | null;
    purpose: OtpPurpose;
    channel: OtpChannel;
    destination: string;
    ip?: string;
    deliver?: boolean;
  }): Promise<ChallengeInfo> {
    const now = this.now();
    // Both caps are per purpose, so e.g. anonymous reset requests can never block someone's login codes.
    const scope = and(eq(otpChallenges.destination, input.destination), eq(otpChallenges.purpose, input.purpose));
    const [recent] = await this.db
      .select({ n: count() })
      .from(otpChallenges)
      .where(and(scope, gt(otpChallenges.createdAt, new Date(now.getTime() - 3600 * 1000))));
    // 4 digits only resist guessing if guesses are scarce: without this, 10 challenges/hour x 5 attempts
    // would allow ~1,200 guesses a day against a 10,000-code space.
    const [failed] = await this.db
      .select({ n: sum(otpChallenges.attempts).mapWith(Number) })
      .from(otpChallenges)
      .where(and(scope, gt(otpChallenges.createdAt, new Date(now.getTime() - 24 * 3600 * 1000))));
    if ((recent?.n ?? 0) >= MAX_CHALLENGES_PER_HOUR || (failed?.n ?? 0) >= MAX_FAILED_ATTEMPTS_PER_DAY) {
      throw new AppError('OTP_RATE_LIMITED', 'Too many verification codes requested. Please try again later.');
    }

    const code = generateCode();
    const [row] = await this.db
      .insert(otpChallenges)
      .values({
        userId: input.userId,
        purpose: input.purpose,
        channel: input.channel,
        destination: input.destination,
        codeHash: hashCode(code, this.config.otpSecret),
        // Audit only; a malformed forwarded address must never fail the request.
        createdIp: input.ip && isIP(input.ip) ? input.ip : null,
        createdAt: now,
        ...this.windows(now),
      })
      .returning();
    if (!row) throw new Error('insert returned no row');

    if (input.deliver !== false) {
      try {
        await this.notifier.sendOtp({ channel: input.channel, destination: input.destination, code, purpose: input.purpose });
      } catch (err) {
        await this.db.delete(otpChallenges).where(eq(otpChallenges.id, row.id));
        throw err;
      }
    }
    return this.info(row);
  }

  /** Marks every unused challenge of this purpose as used, so only a newly issued code can succeed. */
  async invalidateOpen(userId: string, purpose: OtpPurpose): Promise<void> {
    await this.db
      .update(otpChallenges)
      .set({ consumedAt: this.now() })
      .where(and(eq(otpChallenges.userId, userId), eq(otpChallenges.purpose, purpose), isNull(otpChallenges.consumedAt)));
  }

  async resend(challengeId: string): Promise<ChallengeInfo> {
    const row = await this.find(challengeId);
    const now = this.now();
    if (row.consumedAt) throw new AppError('OTP_ALREADY_USED', 'This code has already been used');
    if (row.attempts >= row.maxAttempts) throw new AppError('OTP_LOCKED', 'Too many incorrect attempts. Please start again.');
    if (now < row.resendAvailableAt) {
      throw new AppError('OTP_RESEND_TOO_SOON', 'Please wait before requesting a new code', {
        retryAfterSec: secondsUntil(now, row.resendAvailableAt),
      });
    }
    if (row.resendCount >= MAX_RESENDS) {
      throw new AppError('OTP_RATE_LIMITED', 'Too many codes requested. Please start again.');
    }

    const code = generateCode();
    // Decoy challenges (user_id null) never send anything but otherwise behave identically.
    if (row.userId) {
      await this.notifier.sendOtp({ channel: row.channel, destination: row.destination, code, purpose: row.purpose });
    }
    await this.db
      .update(otpChallenges)
      .set({ codeHash: hashCode(code, this.config.otpSecret), resendCount: row.resendCount + 1, ...this.windows(now) })
      .where(eq(otpChallenges.id, row.id));
    return this.info(row);
  }

  /** `allowed` is checked before anything else, so a code sent for one flow is never burned by another. */
  async verify(
    challengeId: string,
    code: string,
    allowed?: OtpPurpose[],
  ): Promise<{ userId: string | null; purpose: OtpPurpose }> {
    const found = await this.find(challengeId);
    if (allowed && !allowed.includes(found.purpose)) {
      throw new AppError('WRONG_CHALLENGE', 'This code cannot be used here');
    }
    const now = this.now();

    // Decide inside a row lock; throw afterwards so a failed attempt's counter increment is committed.
    const outcome = await this.db.transaction(async (tx): Promise<VerifyOutcome> => {
      const [row] = await tx.select().from(otpChallenges).where(eq(otpChallenges.id, challengeId)).for('update');
      if (!row) return { ok: false, error: new AppError('CHALLENGE_NOT_FOUND', 'Verification request not found. Please start again.') };
      if (row.consumedAt) return { ok: false, error: new AppError('OTP_ALREADY_USED', 'This code has already been used') };
      if (row.attempts >= row.maxAttempts) {
        return { ok: false, error: new AppError('OTP_LOCKED', 'Too many incorrect attempts. Please start again.') };
      }
      if (now >= row.expiresAt) return { ok: false, error: new AppError('OTP_EXPIRED', 'This code has expired. Request a new one.') };

      const expected = Buffer.from(row.codeHash, 'hex');
      const actual = Buffer.from(hashCode(code, this.config.otpSecret), 'hex');
      if (!timingSafeEqual(expected, actual)) {
        const attempts = row.attempts + 1;
        await tx.update(otpChallenges).set({ attempts }).where(eq(otpChallenges.id, row.id));
        const remaining = row.maxAttempts - attempts;
        return {
          ok: false,
          error:
            remaining <= 0
              ? new AppError('OTP_LOCKED', 'Too many incorrect attempts. Please start again.')
              : new AppError('OTP_INVALID', 'The code is incorrect', { attemptsRemaining: remaining }),
        };
      }

      const consumed = await tx
        .update(otpChallenges)
        .set({ consumedAt: now })
        .where(and(eq(otpChallenges.id, row.id), isNull(otpChallenges.consumedAt)))
        .returning({ id: otpChallenges.id });
      if (consumed.length === 0) return { ok: false, error: new AppError('OTP_ALREADY_USED', 'This code has already been used') };
      return { ok: true, row };
    });

    if (!outcome.ok) throw outcome.error;
    return { userId: outcome.row.userId, purpose: outcome.row.purpose };
  }
}
