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
