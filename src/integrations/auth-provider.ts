import {
  createClient,
  isAuthApiError,
  type AuthError,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}

export interface AuthProvider {
  createUser(input: { email: string; password: string }): Promise<{ id: string }>;
  updateUser(id: string, patch: { password?: string; emailConfirmed?: boolean }): Promise<void>;
  deleteUser(id: string): Promise<void>;
  /** Returns a live session when the credentials are valid (caller decides whether to keep it), else null. */
  verifyPassword(email: string, password: string): Promise<AuthSession | null>;
  createSessionForEmail(email: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession | null>;
  revokeSession(accessToken: string): Promise<void>;
  signInWithIdToken(
    provider: 'google' | 'azure',
    idToken: string,
    nonce?: string,
  ): Promise<AuthSession & { email: string; fullName: string | null }>;
}

interface Clients {
  admin: SupabaseClient;
  /** A fresh client per call, so no session state is ever shared between requests. */
  anon: () => SupabaseClient;
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function toSession(s: Session): AuthSession {
  return { accessToken: s.access_token, refreshToken: s.refresh_token, expiresIn: s.expires_in, userId: s.user.id };
}

/**
 * Errors that genuinely mean "these credentials/tokens are no good". Everything else — Supabase's own
 * per-IP rate limit (429), 5xx, network failures, non-JSON bodies — is an outage, not the user's fault.
 */
const REJECTION_CODES = new Set([
  'invalid_credentials',
  'email_not_confirmed',
  'user_banned',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
  'bad_jwt',
  'user_not_found',
]);

function isRejection(err: AuthError): boolean {
  return isAuthApiError(err) && err.status !== 429 && (err.status ?? 0) < 500 && REJECTION_CODES.has(err.code ?? '');
}

function isUnavailable(err: AuthError): boolean {
  // Network failures (AuthRetryableFetchError) and non-JSON bodies (AuthUnknownError) are not AuthApiErrors.
  return !isAuthApiError(err) || err.status === 429 || (err.status ?? 0) >= 500;
}

/** Anything we don't explicitly expect becomes a 503 so the client can retry; details go to the logs only. */
function unavailable(err: unknown): AppError {
  return new AppError('AUTH_PROVIDER_UNAVAILABLE', 'Authentication service is temporarily unavailable', {}, { cause: err });
}

function weakPassword(err: AuthError): AppError | null {
  return isAuthApiError(err) && err.code === 'weak_password'
    ? new AppError('VALIDATION_FAILED', 'Request validation failed', {
        fields: { password: 'Password is too weak' },
      })
    : null;
}

export class SupabaseAuthProvider implements AuthProvider {
  private readonly clients: Clients;

  constructor(config: Config, clients?: Clients) {
    this.clients = clients ?? {
      admin: createClient(config.supabaseUrl, config.supabaseServiceRoleKey, clientOptions),
      anon: () => createClient(config.supabaseUrl, config.supabaseAnonKey, clientOptions),
    };
  }

  private get admin() {
    return this.clients.admin.auth.admin;
  }

  async createUser({ email, password }: { email: string; password: string }) {
    const { data, error } = await this.admin.createUser({ email, password, email_confirm: false });
    if (error) {
      if (isAuthApiError(error) && (error.code === 'email_exists' || error.code === 'user_already_exists')) {
        throw new AppError('EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw weakPassword(error) ?? unavailable(error);
    }
    if (!data.user) throw unavailable('createUser returned no user');
    return { id: data.user.id };
  }

  async updateUser(id: string, patch: { password?: string; emailConfirmed?: boolean }) {
    const attrs: { password?: string; email_confirm?: boolean } = {};
    if (patch.password !== undefined) attrs.password = patch.password;
    if (patch.emailConfirmed !== undefined) attrs.email_confirm = patch.emailConfirmed;
    const { error } = await this.admin.updateUserById(id, attrs);
    if (error) throw weakPassword(error) ?? unavailable(error);
  }

  async deleteUser(id: string) {
    const { error } = await this.admin.deleteUser(id);
    if (error && !(isAuthApiError(error) && error.code === 'user_not_found')) throw unavailable(error);
  }

  async verifyPassword(email: string, password: string) {
    const { data, error } = await this.clients.anon().auth.signInWithPassword({ email, password });
    if (error) {
      if (!isRejection(error)) throw unavailable(error);
      return null; // invalid_credentials, email_not_confirmed, user_banned: all look the same to the caller
    }
    return data.session ? toSession(data.session) : null;
  }

  async createSessionForEmail(email: string) {
    const link = await this.admin.generateLink({ type: 'magiclink', email });
    if (link.error) throw unavailable(link.error);
    const { data, error } = await this.clients
      .anon()
      .auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'email' });
    if (error || !data.session) throw unavailable(error ?? 'verifyOtp returned no session');
    return toSession(data.session);
  }

  async refresh(refreshToken: string) {
    const { data, error } = await this.clients.anon().auth.refreshSession({ refresh_token: refreshToken });
    if (error) {
      if (!isRejection(error)) throw unavailable(error);
      return null;
    }
    return data.session ? toSession(data.session) : null;
  }

  async revokeSession(accessToken: string) {
    const { error } = await this.admin.signOut(accessToken, 'local');
    // An already-expired or already-revoked session is the outcome we wanted anyway.
    if (error && isUnavailable(error)) throw unavailable(error);
  }

  async signInWithIdToken(provider: 'google' | 'azure', idToken: string, nonce?: string) {
    const { data, error } = await this.clients
      .anon()
      .auth.signInWithIdToken({ provider, token: idToken, ...(nonce ? { nonce } : {}) });
    if (error) {
      // A rejected ID token is a 4xx AuthApiError (bad_jwt, validation_failed, provider_disabled, ...).
      if (isUnavailable(error)) throw unavailable(error);
      throw new AppError('UNAUTHORIZED', 'Sign-in with this provider failed', {}, { cause: error });
    }
    if (!data.session || !data.user.email) throw new AppError('UNAUTHORIZED', 'Sign-in with this provider failed');
    const meta = data.user.user_metadata ?? {};
    const fullName = (meta.full_name ?? meta.name ?? null) as string | null;
    return { ...toSession(data.session), email: data.user.email, fullName };
  }
}
