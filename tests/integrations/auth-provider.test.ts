import { describe, expect, it, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from '@supabase/supabase-js';
import { SupabaseAuthProvider } from '../../src/integrations/auth-provider.js';
import { testConfig } from '../helpers/test-config.js';

const session = { access_token: 'at', refresh_token: 'rt', expires_in: 900, user: { id: 'u1', email: 'a@b.com' } };

function stubs() {
  const admin = {
    auth: {
      admin: {
        createUser: vi.fn(),
        updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
        deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
        generateLink: vi.fn().mockResolvedValue({ data: { properties: { hashed_token: 'hashed' } }, error: null }),
        signOut: vi.fn().mockResolvedValue({ data: null, error: null }),
      },
    },
  };
  const anon = {
    auth: {
      signInWithPassword: vi.fn(),
      verifyOtp: vi.fn().mockResolvedValue({ data: { session, user: session.user }, error: null }),
      refreshSession: vi.fn(),
      signInWithIdToken: vi.fn(),
    },
  };
  const provider = new SupabaseAuthProvider(testConfig(), { admin: admin as never, anon: () => anon as never });
  return { admin, anon, provider };
}

describe('SupabaseAuthProvider', () => {
  it('verifyPassword returns null on invalid_credentials', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    });
    expect(await provider.verifyPassword('a@b.com', 'wrong')).toBeNull();
  });

  it('verifyPassword returns the session on success', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithPassword.mockResolvedValue({ data: { session, user: session.user }, error: null });
    expect(await provider.verifyPassword('a@b.com', 'right')).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 900,
      userId: 'u1',
    });
  });

  it('createSessionForEmail calls generateLink then verifyOtp with token_hash and type "email"', async () => {
    const { admin, anon, provider } = stubs();
    const s = await provider.createSessionForEmail('a@b.com');
    expect(admin.auth.admin.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'a@b.com' });
    expect(anon.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'hashed', type: 'email' });
    expect(s.accessToken).toBe('at');
  });

  it('network failure maps to AUTH_PROVIDER_UNAVAILABLE', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthRetryableFetchError('fetch failed', 0),
    });
    await expect(provider.verifyPassword('a@b.com', 'x')).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('treats a Supabase 429 as unavailable, not as wrong credentials', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit'),
    });
    await expect(provider.verifyPassword('a@b.com', 'x')).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    anon.auth.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit'),
    });
    await expect(provider.refresh('rt')).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('treats an unknown (non-JSON) error as unavailable', async () => {
    const { anon, provider } = stubs();
    anon.auth.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthUnknownError('Unexpected token <', new Error('html')),
    });
    await expect(provider.refresh('rt')).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    anon.auth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthUnknownError('Unexpected token <', new Error('html')),
    });
    await expect(provider.signInWithIdToken('google', 't')).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('does not put provider error text in the client-visible extra', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthRetryableFetchError('internal host db-7 refused', 0),
    });
    const err = await provider.verifyPassword('a@b.com', 'x').catch((e: unknown) => e);
    expect(JSON.stringify((err as { extra: unknown }).extra)).not.toContain('db-7');
    expect((err as Error).cause).toBeDefined();
  });

  it('createUser maps an existing email to EMAIL_TAKEN', async () => {
    const { admin, provider } = stubs();
    admin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('A user with this email address has already been registered', 422, 'email_exists'),
    });
    await expect(provider.createUser({ email: 'a@b.com', password: 'pw123456' })).rejects.toMatchObject({
      code: 'EMAIL_TAKEN',
    });
  });

  it('createUser maps a weak password to VALIDATION_FAILED on password', async () => {
    const { admin, provider } = stubs();
    admin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('Password is too weak', 422, 'weak_password'),
    });
    await expect(provider.createUser({ email: 'a@b.com', password: 'pw123456' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      extra: { fields: { password: expect.any(String) } },
    });
  });

  it('createUser creates an unconfirmed user', async () => {
    const { admin, provider } = stubs();
    admin.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'new' } }, error: null });
    expect(await provider.createUser({ email: 'a@b.com', password: 'pw123456' })).toEqual({ id: 'new' });
    expect(admin.auth.admin.createUser).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'pw123456',
      email_confirm: false,
    });
  });

  it('refresh returns null for an unknown refresh token', async () => {
    const { anon, provider } = stubs();
    anon.auth.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found'),
    });
    expect(await provider.refresh('nope')).toBeNull();
  });

  it('refresh returns null for a malformed refresh token (live Supabase answers validation_failed)', async () => {
    const { anon, provider } = stubs();
    anon.auth.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Refresh token is not valid', 400, 'validation_failed'),
    });
    expect(await provider.refresh('not-a-real-token')).toBeNull();
  });

  it('signInWithIdToken passes provider and returns email and name', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithIdToken.mockResolvedValue({
      data: { session, user: { id: 'u1', email: 'g@x.com', user_metadata: { full_name: 'G User' } } },
      error: null,
    });
    const r = await provider.signInWithIdToken('azure', 'id-tok', 'n1');
    expect(anon.auth.signInWithIdToken).toHaveBeenCalledWith({ provider: 'azure', token: 'id-tok', nonce: 'n1' });
    expect(r).toMatchObject({ email: 'g@x.com', fullName: 'G User', userId: 'u1' });
  });

  it('signInWithIdToken rejects an invalid provider token as UNAUTHORIZED', async () => {
    const { anon, provider } = stubs();
    anon.auth.signInWithIdToken.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Bad ID token', 400, 'bad_jwt'),
    });
    await expect(provider.signInWithIdToken('google', 'bad')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
