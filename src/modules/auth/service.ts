import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { profiles } from '../../db/schema.js';
import type { AuthSession } from '../../integrations/auth-provider.js';
import { AppError } from '../../lib/errors.js';
import { toE164 } from '../../lib/phone.js';
import { toUserView } from '../me/view.js';
import type { ChallengeInfo, OtpService } from './otp.js';
import type { registerBody, tokenResponse } from './schemas.js';

type TokenResponse = z.infer<typeof tokenResponse>;
type Profile = typeof profiles.$inferSelect;

export class AuthService {
  constructor(
    private readonly deps: AppDeps,
    private readonly otp: OtpService,
  ) {}

  private async profileByEmail(email: string): Promise<Profile | undefined> {
    const [p] = await this.deps.db.select().from(profiles).where(eq(profiles.email, email));
    return p;
  }

  private async profileById(id: string): Promise<Profile | undefined> {
    const [p] = await this.deps.db.select().from(profiles).where(eq(profiles.id, id));
    return p;
  }

  private tokens(session: AuthSession, profile: Profile, isNewUser: boolean): TokenResponse {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      isNewUser,
      user: toUserView(profile),
    };
  }

  async register(input: z.infer<typeof registerBody>, ip: string): Promise<ChallengeInfo> {
    const { auth, db, config } = this.deps;
    const phoneE164 = toE164(input.dialCode, input.mobile);
    const details = {
      fullName: input.fullName,
      countryName: input.countryName,
      dialCode: input.dialCode,
      mobile: input.mobile,
      phoneE164,
      termsAcceptedAt: new Date(),
      termsVersion: config.termsVersion,
    };

    const existing = await this.profileByEmail(input.email);
    let userId: string;
    if (existing?.status === 'active') {
      throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
    } else if (existing) {
      // An unverified registration can be taken over, so a typo'd or abandoned sign-up never locks the owner out.
      await auth.updateUser(existing.id, { password: input.password });
      await db.update(profiles).set(details).where(eq(profiles.id, existing.id));
      userId = existing.id;
    } else {
      ({ id: userId } = await auth.createUser({ email: input.email, password: input.password }));
      try {
        await db.insert(profiles).values({ id: userId, email: input.email, status: 'pending', ...details });
      } catch (err) {
        await auth.deleteUser(userId).catch(() => undefined);
        throw err;
      }
    }

    return this.otp.issue({ userId, purpose: 'signup', channel: 'email', destination: input.email, ip });
  }

  async login(email: string, password: string, ip: string) {
    const { auth, config } = this.deps;
    const profile = await this.profileByEmail(email);
    if (profile?.status === 'pending') {
      throw new AppError('ACCOUNT_NOT_VERIFIED', 'Please verify your email to finish creating your account');
    }

    const session = await auth.verifyPassword(email, password);
    if (!session || !profile) {
      if (session) await auth.revokeSession(session.accessToken);
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password');
    }

    if (!config.loginOtpRequired) {
      return { otpRequired: false as const, ...this.tokens(session, profile, false) };
    }
    // The password check produced a full session; discard it so only a verified code yields tokens.
    await auth.revokeSession(session.accessToken);
    const info = await this.otp.issue({ userId: profile.id, purpose: 'login', channel: 'email', destination: email, ip });
    return { otpRequired: true as const, ...info };
  }

  async verifyOtp(challengeId: string, code: string): Promise<TokenResponse> {
    const { auth, db } = this.deps;
    const { userId, purpose } = await this.otp.verify(challengeId, code, ['signup', 'login']);
    const profile = userId ? await this.profileById(userId) : undefined;
    if (!profile) throw new AppError('CHALLENGE_NOT_FOUND', 'Verification request not found. Please start again.');

    let active = profile;
    if (purpose === 'signup' && profile.status !== 'active') {
      await auth.updateUser(profile.id, { emailConfirmed: true });
      const [updated] = await db.update(profiles).set({ status: 'active' }).where(eq(profiles.id, profile.id)).returning();
      active = updated ?? profile;
    }
    const session = await auth.createSessionForEmail(profile.email);
    return this.tokens(session, active, purpose === 'signup');
  }

  resendOtp(challengeId: string): Promise<ChallengeInfo> {
    return this.otp.resend(challengeId);
  }

  /** Always succeeds with the same shape, so the endpoint cannot be used to discover accounts. */
  async forgotPassword(email: string, ip: string): Promise<ChallengeInfo> {
    const profile = await this.profileByEmail(email);
    const real = profile?.status === 'active';
    return this.otp.issue({
      userId: real ? profile.id : null,
      purpose: 'password_reset',
      channel: 'email',
      destination: email,
      ip,
      deliver: real,
    });
  }
}
