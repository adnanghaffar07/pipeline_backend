export interface TokenVerifier {
  /** Throws AppError UNAUTHORIZED for any invalid, expired or foreign token. */
  verify(token: string): Promise<{ userId: string }>;
}
