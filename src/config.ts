import { z } from 'zod';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean | number | string;
  databaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseJwtSecret?: string;
  otpSecret: string;
  otpTtlSeconds: number;
  otpResendSeconds: number;
  loginOtpRequired: boolean;
  notifier: 'resend' | 'console';
  resendApiKey?: string;
  emailFrom: string;
  termsVersion: string;
  corsOrigins: string[];
  redisUrl?: string;
  /** Database connections per process: 3 on Vercel (one pool per warm instance), 10 elsewhere. */
  dbPoolMax: number;
  /** True when running as a Vercel function. */
  serverless: boolean;
  /** Firebase service account for push (FCM HTTP v1). Absent = push is off; feeds still work. */
  firebase?: { projectId: string; clientEmail: string; privateKey: string };
  docsEnabled: boolean;
  avatarBucket: string;
  rateLimit: { globalPerMinute: number; authPerMinute: number; loginPerEmailPer15Min: number };
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().positive().default(def);
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // `true` would trust any X-Forwarded-For hop (client-controlled), so require a hop count or address list.
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v, ctx) => {
        const s = v.trim();
        if (s === '' || s === 'false') return false;
        if (/^\d+$/.test(s)) return Number(s);
        if (s === 'true') {
          ctx.addIssue({ code: 'custom', message: 'use a hop count (e.g. 1) or proxy address list instead of true' });
          return z.NEVER;
        }
        return s
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .join(',');
      }),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string')
      .refine(
        (v) => {
          try {
            const u = new URL(v);
            return u.hostname !== '';
          } catch {
            return false;
          }
        },
        // Never echo the value: it contains the database password.
        'is not a complete URL; if the password contains # or other special characters, wrap the value in double quotes or URL-encode them',
      ),
    SUPABASE_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_SECRET: optionalString,
    OTP_SECRET: z.string().min(32, 'must be at least 32 characters'),
    OTP_TTL_SECONDS: int(300),
    OTP_RESEND_SECONDS: int(27),
    LOGIN_OTP_REQUIRED: bool.default(true),
    NOTIFIER: z.enum(['resend', 'console']).default('resend'),
    RESEND_API_KEY: optionalString,
    EMAIL_FROM: z.string().min(3),
    TERMS_VERSION: z.string().min(1),
    CORS_ORIGINS: z.string().default(''),
    REDIS_URL: optionalString,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
    VERCEL: optionalString,
    // The service-account JSON from Firebase, pasted as-is or base64-encoded.
    FIREBASE_SERVICE_ACCOUNT: optionalString.transform((v, ctx) => {
      if (!v) return undefined;
      const text = v.startsWith('{') ? v : Buffer.from(v, 'base64').toString('utf8');
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        if (typeof j.project_id === 'string' && typeof j.client_email === 'string' && typeof j.private_key === 'string') {
          return { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key.replace(/\\n/g, '\n') };
        }
      } catch {
        // fall through
      }
      // Never echo the value: it contains a private key.
      ctx.addIssue({ code: 'custom', message: 'must be the Firebase service-account JSON (project_id, client_email, private_key)' });
      return z.NEVER;
    }),
    DOCS_ENABLED: bool.optional(),
    AVATAR_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'must be a lower-case bucket name').default('avatars'),
    RATE_LIMIT_GLOBAL_PER_MINUTE: int(300),
    RATE_LIMIT_AUTH_PER_MINUTE: int(10),
    RATE_LIMIT_LOGIN_PER_EMAIL_PER_15_MIN: int(10),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.NOTIFIER === 'console') {
      ctx.addIssue({ code: 'custom', path: ['NOTIFIER'], message: 'console notifier is not allowed in production' });
    }
    if (env.NOTIFIER === 'resend' && !env.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required when NOTIFIER=resend' });
    }
  });

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // `KEY=` in a .env file means "not set", so defaults apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    supabaseUrl: e.SUPABASE_URL,
    supabaseAnonKey: e.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    supabaseJwtSecret: e.SUPABASE_JWT_SECRET,
    otpSecret: e.OTP_SECRET,
    otpTtlSeconds: e.OTP_TTL_SECONDS,
    otpResendSeconds: e.OTP_RESEND_SECONDS,
    loginOtpRequired: e.LOGIN_OTP_REQUIRED,
    notifier: e.NOTIFIER,
    resendApiKey: e.RESEND_API_KEY,
    emailFrom: e.EMAIL_FROM,
    termsVersion: e.TERMS_VERSION,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    redisUrl: e.REDIS_URL,
    serverless: Boolean(e.VERCEL),
    dbPoolMax: e.DB_POOL_MAX ?? (e.VERCEL ? 3 : 10),
    firebase: e.FIREBASE_SERVICE_ACCOUNT,
    docsEnabled: e.DOCS_ENABLED ?? e.NODE_ENV !== 'production',
    avatarBucket: e.AVATAR_BUCKET,
    rateLimit: {
      globalPerMinute: e.RATE_LIMIT_GLOBAL_PER_MINUTE,
      authPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE,
      loginPerEmailPer15Min: e.RATE_LIMIT_LOGIN_PER_EMAIL_PER_15_MIN,
    },
  };
}
