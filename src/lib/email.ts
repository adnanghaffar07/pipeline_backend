export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `adnan@example.com` -> `a***n@example.com`; short local parts keep only the first character. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const masked = local.length <= 2 ? `${local[0] ?? ''}***` : `${local[0]}***${local[local.length - 1]}`;
  return masked + domain;
}
