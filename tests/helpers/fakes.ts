import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import type { AuthProvider, AuthSession } from '../../src/integrations/auth-provider.js';
import type { Notifier } from '../../src/integrations/notifier.js';
import { AppError } from '../../src/lib/errors.js';
import { TEST_JWT_SECRET } from './test-config.js';

export const TEST_ISSUER = 'https://test.supabase.co/auth/v1';
const key = new TextEncoder().encode(TEST_JWT_SECRET);

export async function signTestToken(userId: string, expiresIn: string | number = '15m'): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuer(TEST_ISSUER)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(expiresIn)
    .sign(key);
}

interface FakeUser {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
}

interface FakeSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  revoked: boolean;
}

/** In-memory Supabase Auth stand-in. Mirrors users into the PGlite `auth.users` stub so FKs hold. */
export class FakeAuthProvider implements AuthProvider {
  readonly users = new Map<string, FakeUser>();
  readonly sessions: FakeSession[] = [];
  readonly idTokenCalls: Array<{ provider: string; idToken: string }> = [];
  private failing = false;

  constructor(private readonly db: Db) {}

  failNext() {
    this.failing = true;
  }

  private checkFail() {
    if (this.failing) {
      this.failing = false;
      throw new AppError('AUTH_PROVIDER_UNAVAILABLE', 'Authentication service is temporarily unavailable');
    }
  }

  byEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }

  private async newSession(userId: string): Promise<AuthSession> {
    const s: FakeSession = { userId, accessToken: await signTestToken(userId), refreshToken: `rt_${randomUUID()}`, revoked: false };
    this.sessions.push(s);
    return { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresIn: 900, userId };
  }

  async createUser({ email, password }: { email: string; password: string }) {
    this.checkFail();
    if (this.byEmail(email)) throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
    const id = randomUUID();
    this.users.set(id, { id, email, password, confirmed: false });
    await this.db.execute(sql`insert into auth.users (id, email) values (${id}, ${email})`);
    return { id };
  }

  async updateUser(id: string, patch: { password?: string; emailConfirmed?: boolean }) {
    this.checkFail();
    const u = this.users.get(id);
    if (!u) throw new Error(`fake: no user ${id}`);
    if (patch.password !== undefined) u.password = patch.password;
    if (patch.emailConfirmed !== undefined) u.confirmed = patch.emailConfirmed;
  }

  async deleteUser(id: string) {
    this.checkFail();
    this.users.delete(id);
    await this.db.execute(sql`delete from auth.users where id = ${id}`);
  }

  async verifyPassword(email: string, password: string) {
    this.checkFail();
    const u = this.byEmail(email);
    if (!u || u.password !== password || !u.confirmed) return null;
    return this.newSession(u.id);
  }

  async createSessionForEmail(email: string) {
    this.checkFail();
    const u = this.byEmail(email);
    if (!u) throw new Error(`fake: no user ${email}`);
    u.confirmed = true;
    return this.newSession(u.id);
  }

  async refresh(refreshToken: string) {
    this.checkFail();
    const s = this.sessions.find((x) => x.refreshToken === refreshToken && !x.revoked);
    if (!s) return null;
    s.revoked = true; // rotation
    return this.newSession(s.userId);
  }

  async revokeSession(accessToken: string) {
    this.checkFail();
    const s = this.sessions.find((x) => x.accessToken === accessToken);
    if (s) s.revoked = true;
  }

  isRevoked(accessToken: string) {
    return this.sessions.find((x) => x.accessToken === accessToken)?.revoked ?? false;
  }

  /** idToken format for tests: `valid:<email>:<full name or empty>`. */
  async signInWithIdToken(provider: 'google' | 'azure', idToken: string) {
    this.checkFail();
    this.idTokenCalls.push({ provider, idToken });
    const [tag, email, name] = idToken.split(':');
    if (tag !== 'valid' || !email) throw new AppError('UNAUTHORIZED', 'Sign-in with this provider failed');
    let u = this.byEmail(email);
    if (!u) {
      const id = randomUUID();
      u = { id, email, password: randomUUID(), confirmed: true };
      this.users.set(id, u);
      await this.db.execute(sql`insert into auth.users (id, email) values (${id}, ${email})`);
    }
    return { ...(await this.newSession(u.id)), email, fullName: name || null };
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: Array<{ destination: string; code: string; purpose: string; channel: string }> = [];
  private failing = false;

  failNext() {
    this.failing = true;
  }

  async sendOtp(input: Parameters<Notifier['sendOtp']>[0]) {
    if (this.failing) {
      this.failing = false;
      throw new AppError('EMAIL_DELIVERY_FAILED', 'We could not send the email. Please try again shortly.');
    }
    this.sent.push({ ...input });
  }

  lastCode(destination: string): string {
    const hit = [...this.sent].reverse().find((s) => s.destination === destination);
    if (!hit) throw new Error(`fake: nothing sent to ${destination}`);
    return hit.code;
  }
}
