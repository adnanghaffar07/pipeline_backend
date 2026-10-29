# Foundation + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A production-ready Fastify/TypeScript API with Supabase-backed auth (4-digit email OTP), `/me`, account deletion and interests, plus the shared foundation every later module uses.

**Architecture:** `buildApp(deps)` assembles plugins and feature modules from injected dependencies (config, Drizzle db, AuthProvider, Notifier, TokenVerifier), so tests run the real app against PGlite with fake Supabase/Resend. Supabase Auth owns users and tokens; our `otp_challenges` table owns the 4-digit codes; a verified code is exchanged for a real Supabase session via `generateLink` + `verifyOtp`.

**Tech Stack:** Node 24, TypeScript 5 (strict, ESM, `module: NodeNext`), Fastify 5, fastify-type-provider-zod + zod, @fastify/helmet, @fastify/cors, @fastify/rate-limit, @fastify/swagger, @fastify/swagger-ui, drizzle-orm + postgres (postgres.js), drizzle-kit, @supabase/supabase-js, jose, resend, libphonenumber-js, ioredis (optional). Dev: vitest, @electric-sql/pglite, tsx, eslint + typescript-eslint.

**Spec:** `docs/superpowers/specs/2026-10-29-foundation-auth-design.md`

## Global Constraints

- All feature routes under `/api/v1`; `/health/*` and `/docs*` unversioned.
- Error body: `{ "error": { "code": string, "message": string, "fields"?: Record<string,string>, ...extra } }`.
- List body: `{ "items": [], "nextCursor": string | null, "total": number }`.
- Timestamps are ISO-8601 strings; never preformatted relative times.
- Emails are trimmed + lower-cased before any lookup or storage.
- OTP: 4 digits, TTL 300 s, resend cooldown 27 s, max 5 attempts, max 5 resends, max 10 challenges per destination per hour; HMAC-SHA256 with `OTP_SECRET`; `timingSafeEqual`.
- Password: 8–72 chars. fullName: 1–100 chars after trim.
- Never log or return: passwords, OTP codes, code hashes, tokens.
- All public tables: `enable row level security`, no policies.
- `NODE_ENV=production` must reject `NOTIFIER=console` and `DOCS_ENABLED` defaults to `false` in production.
- No real Supabase or Resend calls from tests.

## Review Focus

1. **Email casing/whitespace** — registering `" Adnan@Example.com "` then logging in as `adnan@example.com` must work (test in Task 6).
2. **Double-tap verify** — the same correct code submitted twice must yield one session and `409 OTP_ALREADY_USED` on the second (test in Task 5).
3. **Codes with leading zeros / numeric JSON** — `"0042"` is valid; `42` (number) or `"42"` is `422 VALIDATION_FAILED` (test in Task 6).
4. **Email provider down** — Notifier throwing must return `503 EMAIL_DELIVERY_FAILED`, never a raw 500 or a leaked stack (test in Task 6).
5. **Deleted user with a still-valid access token** — `/me` returns `401 UNAUTHORIZED`, not 500 or stale data (test in Task 8).

## File Map

```
package.json  tsconfig.json  tsconfig.build.json  eslint.config.js  vitest.config.ts
drizzle.config.ts  .gitignore  .env.example  .dockerignore  Dockerfile  README.md
.github/workflows/ci.yml
src/config.ts                      loadConfig(env) -> Config
src/app.ts                         buildApp(deps) -> FastifyInstance
src/server.ts                      production entrypoint
src/lib/errors.ts                  AppError, ErrorCode, errorHandler, notFoundHandler
src/lib/logger.ts                  loggerOptions(config)
src/lib/pagination.ts              encodeCursor, decodeCursor, listEnvelope
src/lib/phone.ts                   toE164(dialCode, mobile)
src/lib/email.ts                   normalizeEmail, maskEmail
src/lib/auth-guard.ts              authGuard plugin: app.authenticate, request.user
src/lib/token-verifier.ts          TokenVerifier interface + createTokenVerifier(config)
src/plugins/security.ts            helmet, cors, rate-limit
src/plugins/swagger.ts             OpenAPI + UI
src/plugins/health.ts              /health/live, /health/ready
src/db/schema.ts                   Drizzle tables
src/db/client.ts                   createDb(url) -> { db, close }; type Db
src/db/migrate.ts                  runMigrations(url)
src/db/migrations/*.sql            generated + custom seed migration
src/integrations/notifier.ts       Notifier, ResendNotifier, ConsoleNotifier, createNotifier
src/integrations/auth-provider.ts  AuthProvider, AuthSession, SupabaseAuthProvider
src/modules/auth/otp.ts            OtpService + pure helpers
src/modules/auth/schemas.ts        zod request/response schemas
src/modules/auth/service.ts        AuthService
src/modules/auth/routes.ts         authRoutes plugin
src/modules/me/{schemas,service,routes}.ts
src/modules/interests/{schemas,service,routes}.ts
tests/helpers/test-db.ts           createTestDb() -> PGlite + migrations
tests/helpers/fakes.ts             FakeAuthProvider, FakeNotifier
tests/helpers/test-app.ts          createTestApp(overrides?)
tests/**/*.test.ts
```

## Shared Interfaces (referenced by tasks)

```ts
// src/config.ts
export interface Config {
  nodeEnv: 'development' | 'test' | 'production'; host: string; port: number; logLevel: string;
  trustProxy: boolean; databaseUrl: string;
  supabaseUrl: string; supabaseAnonKey: string; supabaseServiceRoleKey: string; supabaseJwtSecret?: string;
  otpSecret: string; otpTtlSeconds: number; otpResendSeconds: number; loginOtpRequired: boolean;
  notifier: 'resend' | 'console'; resendApiKey?: string; emailFrom: string;
  termsVersion: string; corsOrigins: string[]; redisUrl?: string; docsEnabled: boolean;
  rateLimit: { globalPerMinute: number; authPerMinute: number; loginPerEmailPer15Min: number };
}

// src/db/client.ts
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>; // works for postgres-js and pglite drivers

// src/integrations/auth-provider.ts
export interface AuthSession { accessToken: string; refreshToken: string; expiresIn: number; userId: string }
export interface AuthProvider {
  createUser(i: { email: string; password: string }): Promise<{ id: string }>;
  updateUser(id: string, p: { password?: string; emailConfirmed?: boolean }): Promise<void>;
  deleteUser(id: string): Promise<void>;
  verifyPassword(email: string, password: string): Promise<AuthSession | null>;
  createSessionForEmail(email: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession | null>;
  revokeSession(accessToken: string): Promise<void>;
  signInWithIdToken(provider: 'google' | 'azure', idToken: string, nonce?: string):
    Promise<AuthSession & { email: string; fullName: string | null }>;
}

// src/integrations/notifier.ts
export type OtpPurpose = 'signup' | 'login' | 'password_reset';
export interface Notifier {
  sendOtp(i: { channel: 'email' | 'sms'; destination: string; code: string; purpose: OtpPurpose }): Promise<void>;
}

// src/lib/token-verifier.ts
export interface TokenVerifier { verify(token: string): Promise<{ userId: string }> } // throws AppError UNAUTHORIZED

// src/app.ts
export interface AppDeps { config: Config; db: Db; auth: AuthProvider; notifier: Notifier; tokens: TokenVerifier }
```

### Error codes (`src/lib/errors.ts`)

| Code | HTTP |
|---|---|
| VALIDATION_FAILED | 422 |
| UNAUTHORIZED | 401 |
| INVALID_CREDENTIALS | 401 |
| INVALID_REFRESH_TOKEN | 401 |
| ACCOUNT_NOT_VERIFIED | 403 |
| FORBIDDEN | 403 |
| NOT_FOUND / CHALLENGE_NOT_FOUND | 404 |
| EMAIL_TAKEN / OTP_ALREADY_USED | 409 |
| OTP_EXPIRED | 410 |
| OTP_LOCKED | 423 |
| OTP_INVALID / WRONG_CHALLENGE / INVALID_TOPICS | 400 |
| RATE_LIMITED / OTP_RESEND_TOO_SOON / OTP_RATE_LIMITED | 429 |
| EMAIL_DELIVERY_FAILED / AUTH_PROVIDER_UNAVAILABLE | 503 |
| INTERNAL | 500 |

`new AppError(code: ErrorCode, message: string, extra?: { fields?: Record<string,string>; [k: string]: unknown })` — status derived from the table.

---

### Task 1: Scaffold + config

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:** Produces `Config`, `loadConfig(env: NodeJS.ProcessEnv): Config` (throws `Error` listing every invalid var).

- [ ] **Step 1:** `npm init`, install deps from Tech Stack (pick zod major supported by the installed fastify-type-provider-zod). Scripts: `dev` (`tsx watch --env-file=.env src/server.ts`), `build` (`tsc -p tsconfig.build.json`), `start` (`node dist/server.js`), `test` (`vitest run`), `lint` (`eslint .`), `typecheck` (`tsc --noEmit`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`node --env-file=.env dist/db/migrate.js` after build; also `tsx --env-file=.env src/db/migrate.ts` as `db:migrate:dev`). `"engines": { "node": ">=24" }`, `"type": "module"`. `.gitignore`: `node_modules`, `dist`, `.env`, `coverage`.
- [ ] **Step 2: Write failing tests** `tests/config.test.ts`:
  - `loads a valid env with defaults` → `otpTtlSeconds === 300`, `otpResendSeconds === 27`, `loginOtpRequired === true`, `port === 3000`, `corsOrigins` parsed from comma list.
  - `rejects short OTP_SECRET` → throws mentioning `OTP_SECRET`.
  - `rejects console notifier in production` → throws mentioning `NOTIFIER`.
  - `requires RESEND_API_KEY when NOTIFIER=resend`.
  - `docsEnabled defaults to false in production, true otherwise`.
- [ ] **Step 3:** Run `npx vitest run tests/config.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `loadConfig` with a zod schema over env strings (booleans accept `true/false`), collecting all issues into one error message.
- [ ] **Step 5:** Run tests → PASS. Run `npm run typecheck` and `npm run lint` → clean.
- [ ] **Step 6:** `.env.example` lists every var from spec §7 with placeholder values and `SUPABASE_URL=https://vrckchkooikpvmbinsed.supabase.co`.
- [ ] **Step 7:** Commit `chore: scaffold project and validated config`.

### Task 2: App skeleton, errors, logging, security, docs, health

**Files:**
- Create: `src/lib/errors.ts`, `src/lib/logger.ts`, `src/lib/pagination.ts`, `src/plugins/security.ts`, `src/plugins/swagger.ts`, `src/plugins/health.ts`, `src/app.ts`
- Test: `tests/app.test.ts`, `tests/lib/pagination.test.ts`

**Interfaces:**
- Produces `AppError`, `ErrorCode`, `buildApp(deps: AppDeps): Promise<FastifyInstance>`; `encodeCursor(obj: Record<string, unknown>): string`, `decodeCursor<T>(c: string): T` (throws `VALIDATION_FAILED` on garbage), `listEnvelope<T>(items: T[], nextCursor: string | null, total: number)`.
- `buildApp` registers, in order: zod validator/serializer compilers, security plugin, swagger (if `docsEnabled`), health, then each module under prefix `/api/v1` (modules added by later tasks). Health `ready` runs `select 1` on `deps.db`.

- [ ] **Step 1: Write failing tests** (`tests/app.test.ts`, build app with a test route registered via an `extraRoutes` option on `buildApp` for test only, or register routes on the returned instance before `ready()`):
  - `unknown route returns 404 NOT_FOUND envelope`.
  - `zod failure returns 422 VALIDATION_FAILED with fields { email: <reason> }`.
  - `thrown AppError('EMAIL_TAKEN') returns 409 with code`.
  - `unexpected Error returns 500 INTERNAL and message "Internal server error"` (no stack in body).
  - `x-request-id is echoed; generated when absent`.
  - `GET /health/live -> 200 { status: "ok" }`; `GET /health/ready -> 200 { status: "ok", db: "ok" }`.
  - `logs redact password and authorization` — capture pino output via a stream option, POST `{password:"secret123"}` and assert `secret123` absent.
  - `rate limit returns 429 RATE_LIMITED envelope` (config `globalPerMinute: 2`, third request).
  - `GET /docs/json returns openapi 3 document when docsEnabled`.
  - pagination: `round-trips a cursor`, `rejects a malformed cursor with VALIDATION_FAILED`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Error handler maps: `AppError` → its status; `hasZodFastifySchemaValidationErrors(err)` → 422 with `fields` keyed by dotted path; rate-limit plugin `errorResponseBuilder` → 429 `RATE_LIMITED`; anything else → log at `error` and return 500. Logger: `redact.paths` for `req.headers.authorization`, `req.headers.cookie`, and `*.password`, `*.newPassword`, `*.code`, `*.refreshToken`, `*.accessToken`, `*.idToken`, `censor: '[REDACTED]'`. `genReqId` uses incoming `x-request-id` (≤128 chars) else `crypto.randomUUID()`; `onSend` hook sets the header. `bodyLimit: 102400`. Rate limit uses `ioredis` store when `redisUrl` set. Tests may pass a minimal `db` stub until Task 3 provides PGlite.
- [ ] **Step 4:** Run → PASS; typecheck + lint clean.
- [ ] **Step 5:** Commit `feat: app skeleton with error envelope, logging, security, docs, health`.

### Task 3: Database schema, migrations, test DB

**Files:**
- Create: `drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/migrations/0000_*.sql` (generated), `src/db/migrations/0001_seed_interest_topics.sql` (custom via `drizzle-kit generate --custom`), `tests/helpers/test-db.ts`
- Test: `tests/db/migrations.test.ts`

**Interfaces:**
- Produces Drizzle tables `profiles`, `otpChallenges`, `interestTopics`, `userInterests` (columns exactly as spec §4); `createDb(url: string): { db: Db; close(): Promise<void> }` (postgres.js with `prepare: false`, `max: 10`); `runMigrations(url: string): Promise<void>`; `createTestDb(): Promise<{ db: Db; client: PGlite; close(): Promise<void> }>`.
- `createTestDb` runs, before migrations: `create schema auth; create table auth.users (id uuid primary key, email text); create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade);` then `migrate()` from `drizzle-orm/pglite/migrator` with `migrationsFolder: 'src/db/migrations'`.
- Foreign keys to `auth.users` are declared in schema.ts with a Drizzle `pgSchema('auth').table('users', { id: uuid('id') })` reference that is excluded from generation (`schemaFilter: ['public']` in drizzle.config.ts).

- [ ] **Step 1: Write failing tests:**
  - `applies migrations and seeds 17 topics in sort order` — first `name` is `Network Transformation`, last is `Operational Agility` (Appendix B order).
  - `enables RLS on every public table` — `select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity` returns zero rows.
  - `cascades profile and interests when auth user is deleted`.
  - `rejects duplicate profile email`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Write schema, generate migration, append `alter table ... enable row level security;` for each table to the generated SQL, write the seed migration (17 rows with slugs, `sort_order` 1–17, `on conflict (slug) do nothing`).
- [ ] **Step 4:** Run → PASS. Wire `/health/ready` tests from Task 2 to use `createTestDb`.
- [ ] **Step 5:** Commit `feat: database schema, migrations and topic seed`.

### Task 4: Integrations — notifier, auth provider, token verifier, test fakes

**Files:**
- Create: `src/integrations/notifier.ts`, `src/integrations/auth-provider.ts`, `src/lib/token-verifier.ts`, `src/lib/email.ts`, `src/lib/phone.ts`, `tests/helpers/fakes.ts`
- Test: `tests/integrations/notifier.test.ts`, `tests/integrations/auth-provider.test.ts`, `tests/lib/token-verifier.test.ts`, `tests/lib/email-phone.test.ts`

**Interfaces:**
- Produces `Notifier`, `createNotifier(config): Notifier`, `ResendNotifier(client: Pick<Resend,'emails'>, from: string)`, `ConsoleNotifier(logger)`; `AuthProvider`, `SupabaseAuthProvider(config)`; `createTokenVerifier(config): TokenVerifier`; `normalizeEmail(s): string`, `maskEmail(s): string` (`adnan@example.com` → `a***n@example.com`, 1–2 char local part → `a***@example.com`); `toE164(dialCode: string, mobile: string): string` (throws `VALIDATION_FAILED` with `fields.mobile`).
- `FakeNotifier`: records `sent: Array<{destination, code, purpose}>`, `lastCode(destination)`, `failNext()`.
- `FakeAuthProvider(db: Db)`: in-memory `{id,email,password,confirmed}`; `createUser` also inserts into `auth.users`; `deleteUser` deletes from `auth.users`; sessions are `access-<uuid>` strings tracked in a map; `failNext()` makes the next call throw `AUTH_PROVIDER_UNAVAILABLE`.

- [ ] **Step 1: Write failing tests:**
  - ResendNotifier: `sends subject "Your Pipeline verification code" with the code in html and text`; `maps a Resend error to AppError EMAIL_DELIVERY_FAILED`. Subjects: signup/login → `Your Pipeline verification code`, password_reset → `Reset your Pipeline password`. Body states the code and that it expires in 5 minutes. `sms` channel throws `Error('SMS channel not configured')`.
  - Token verifier (HS256 via `supabaseJwtSecret`): `accepts a valid token and returns sub`; rejects expired, wrong `aud`, wrong `iss`, bad signature — each with `UNAUTHORIZED`.
  - SupabaseAuthProvider with a stubbed supabase client injected through the constructor's optional second argument: `verifyPassword returns null on invalid_credentials`; `createSessionForEmail calls generateLink then verifyOtp with token_hash and type "email"`; `network failure maps to AUTH_PROVIDER_UNAVAILABLE`; `createUser maps "already registered" to EMAIL_TAKEN`.
  - email/phone: normalise `" A@B.COM "` → `a@b.com`; masks; `toE164('+92','3001234567')` → `+923001234567`; invalid mobile throws.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Supabase clients created with `{ auth: { persistSession: false, autoRefreshToken: false } }`: one admin (service-role) client, and a fresh anon client per password/OTP call so sessions never leak between requests. `revokeSession` → `admin.auth.admin.signOut(token, 'local')`. `refresh` → `anon.auth.refreshSession({ refresh_token })`. Token verifier: if `supabaseJwtSecret` set, verify HS256 with it; otherwise `createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))`; always check `issuer: `${supabaseUrl}/auth/v1``, `audience: 'authenticated'`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: notifier, Supabase auth provider and token verifier`.

### Task 5: OTP service

**Files:**
- Create: `src/modules/auth/otp.ts`
- Test: `tests/auth/otp.test.ts`

**Interfaces:**
- Produces:
  - `generateCode(): string` (`crypto.randomInt(0, 10000)` padded to 4), `hashCode(code: string, secret: string): string`.
  - `interface ChallengeInfo { challengeId: string; channel: 'email' | 'sms'; destinationMasked: string; resendAvailableInSec: number }`
  - `class OtpService { constructor(db: Db, notifier: Notifier, config: Config, now: () => Date = () => new Date()) }`
    - `issue(i: { userId: string | null; purpose: OtpPurpose; channel: 'email'; destination: string; ip?: string; deliver?: boolean }): Promise<ChallengeInfo>` — `deliver: false` stores without sending (used for unknown-email reset).
    - `resend(challengeId: string): Promise<ChallengeInfo>`
    - `verify(challengeId: string, code: string): Promise<{ userId: string | null; purpose: OtpPurpose }>`

- [ ] **Step 1: Write failing tests** (PGlite + FakeNotifier + controllable `now`):
  - `issue stores a hash, never the code, and sends the code` (row `code_hash !== code`, `/^\d{4}$/` code sent).
  - `verify succeeds with the right code and consumes the challenge`.
  - `second verify of a consumed challenge -> OTP_ALREADY_USED` (Review Focus 2).
  - `wrong code -> OTP_INVALID with attemptsRemaining 4, then 3...`; `5th wrong -> OTP_LOCKED`; `correct code after lock -> OTP_LOCKED`.
  - `expired after 300 s -> OTP_EXPIRED`.
  - `resend before 27 s -> OTP_RESEND_TOO_SOON with retryAfterSec`; `resend at 27 s issues a new code, old code fails, expiry reset`; `6th resend -> OTP_RATE_LIMITED`.
  - `11th challenge for a destination within an hour -> OTP_RATE_LIMITED`.
  - `unknown id (valid uuid) -> CHALLENGE_NOT_FOUND`; `non-uuid id -> CHALLENGE_NOT_FOUND` (no DB error).
  - `notifier failure surfaces EMAIL_DELIVERY_FAILED` and the challenge row is not left usable (deleted).
  - `deliver:false sends nothing`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Verify flow inside one transaction with `select ... for update`: check consumed → expired → locked → compare with `timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(row.codeHash))`; on mismatch increment attempts; on match `update ... set consumed_at = now() where id = $1 and consumed_at is null returning id` and throw `OTP_ALREADY_USED` if no row returned.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: OTP challenge service`.

### Task 6: Register, login, verify, resend

**Files:**
- Create: `src/modules/auth/schemas.ts`, `src/modules/auth/service.ts`, `src/modules/auth/routes.ts`, `tests/helpers/test-app.ts`
- Modify: `src/app.ts` (register `authRoutes` at `/api/v1/auth`)
- Test: `tests/auth/register-login.test.ts`

**Interfaces:**
- Produces `createTestApp(overrides?: Partial<Config>): Promise<{ app; db; auth: FakeAuthProvider; notifier: FakeNotifier; signToken(userId: string, opts?: { expiresIn?: string }): Promise<string>; close() }>` (HS256 with a test `supabaseJwtSecret`).
- `class AuthService { constructor(deps: AppDeps, otp: OtpService) }` with `register`, `login`, `verifyOtp`, `resendOtp` (and in Task 7 `refresh`, `logout`, `forgotPassword`, `resetPassword`, `oauth`).
- `UserView` (zod, reused by Task 7/8): `{ id, fullName, email, avatarUrl: string|null, xpTotal: 0, level: { number: 1, name: 'Explorer' }, subscription: { status: 'free' } }`.
- Token response: `{ accessToken, refreshToken, expiresIn, isNewUser, user: UserView }`.
- Routes use per-route rate limit `config.rateLimit.authPerMinute`; `/login` additionally keyed on `normalizeEmail(body.email)` with `loginPerEmailPer15Min` over `15 minutes`.

- [ ] **Step 1: Write failing tests:**
  - `register -> 201 { challengeId, channel: "email", destinationMasked, resendAvailableInSec: 27 }`, profile `pending`, terms timestamp + `termsVersion` stored, `phone_e164` stored.
  - `register validation`: missing `termsAccepted` or `false` → 422 `fields.termsAccepted`; 7-char password → 422; bad mobile → 422 `fields.mobile`.
  - `register with active email -> 409 EMAIL_TAKEN`; `register again with pending email -> 201, password updated, new code sent`.
  - `verify signup -> 200 tokens, isNewUser true, profile active, auth user confirmed`.
  - `email casing` (Review Focus 1): register `" Adnan@Example.com "`, verify, login `adnan@example.com` → 200.
  - `login pending -> 403 ACCOUNT_NOT_VERIFIED`; `wrong password -> 401 INVALID_CREDENTIALS`; `unknown email -> 401 INVALID_CREDENTIALS` with identical message.
  - `login -> { otpRequired: true, challengeId }`, the password-check session is revoked (fake records revocation); `verify login -> isNewUser false`.
  - `loginOtpRequired=false -> { otpRequired: false, accessToken, ... }`.
  - `code "0042" format accepted by schema; numeric 42 and "42" -> 422` (Review Focus 3).
  - `notifier down on register -> 503 EMAIL_DELIVERY_FAILED` (Review Focus 4); `auth provider down on login -> 503 AUTH_PROVIDER_UNAVAILABLE`.
  - `resend -> 429 OTP_RESEND_TOO_SOON` immediately.
  - `login per-email limit -> 429 after 10 attempts` (set `authPerMinute` high for this test).
  - `verify with a password_reset challenge -> 400 WRONG_CHALLENGE`.
  - `response bodies never contain "code_hash" or the password`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement schemas, service, routes. Register for pending users: `auth.updateUser(id, { password })` and update profile fields. Verify signup: `auth.updateUser(id, { emailConfirmed: true })`, set profile `active`, then `auth.createSessionForEmail(email)`.
- [ ] **Step 4:** Run → PASS; full suite green.
- [ ] **Step 5:** Commit `feat: register, login and OTP verification`.

### Task 7: Refresh, logout, password reset, OAuth

**Files:**
- Modify: `src/modules/auth/{schemas,service,routes}.ts`
- Create: `src/lib/auth-guard.ts` (needed by logout)
- Modify: `src/app.ts` (register `authGuard` before modules)
- Test: `tests/auth/session-reset-oauth.test.ts`

**Interfaces:**
- Produces `authGuard` plugin decorating `app.authenticate` (preHandler) and `request.user: { id: string; email: string; accessToken: string }`. It verifies the bearer token via `deps.tokens`, loads the profile, and throws `UNAUTHORIZED` when the header is missing/malformed, the token is invalid, or the profile is missing or not `active`.

- [ ] **Step 1: Write failing tests:**
  - `refresh -> new tokens`; `invalid refresh -> 401 INVALID_REFRESH_TOKEN`.
  - `logout requires bearer (401 without)`; `logout -> 204 and revokes that access token`.
  - `forgot for active user -> 200 and sends password_reset email`; `forgot for unknown email -> 200 same shape, nothing sent`; `forgot for pending user -> same as unknown`.
  - `reset with correct code -> 204, password changed, all auth.sessions rows for user deleted`; `reset on the unknown-email challenge with any code -> 400 OTP_INVALID`; `reset newPassword < 8 -> 422`.
  - `reset with a login challenge -> 400 WRONG_CHALLENGE`.
  - `oauth google first time -> 200 isNewUser true, active profile created with fullName fallback = email local part`; `second time -> isNewUser false`; `provider "linkedin" -> 422`; `microsoft maps to azure` (fake records provider).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Reset deletes sessions with `db.execute(sql\`delete from auth.sessions where user_id = ${userId}\`)`. OAuth upserts the profile `on conflict (id) do nothing` and reports `isNewUser` from whether the insert happened; if a `pending` profile with the same email exists, activate it.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: token refresh, logout, password reset and OAuth sign-in`.

### Task 8: /me, account deletion, interests

**Files:**
- Create: `src/modules/me/{schemas,service,routes}.ts`, `src/modules/interests/{schemas,service,routes}.ts`
- Modify: `src/app.ts` (register `meRoutes` at `/api/v1/me`, `interestsRoutes` at `/api/v1`)
- Test: `tests/me/me.test.ts`, `tests/interests/interests.test.ts`

**Interfaces:**
- `GET /me` → `UserView & { unreadNotifications: 0 }`. `DELETE /me` → 204 after `auth.deleteUser(id)`.
- `GET /interests/topics` (public) → `listEnvelope(topics: {id, name}[], null, 17)` ordered by `sort_order`, active only.
- `GET /me/interests` → `{ topicIds: number[] }` ascending. `PUT /me/interests` body `{ topicIds: number[] (1..17 items, unique) }` → `{ topicIds }`.

- [ ] **Step 1: Write failing tests:**
  - `GET /me -> UserView with xpTotal 0, level Explorer, subscription free, unreadNotifications 0`.
  - `GET /me without token -> 401`; `expired token -> 401`.
  - `deleted user with valid token -> 401 UNAUTHORIZED` (Review Focus 5).
  - `DELETE /me -> 204, profile, interests and challenges gone`.
  - `topics -> 17 items, total 17, nextCursor null`.
  - `PUT interests replaces selection`; `empty array -> 422`; `duplicate ids -> 422`; `unknown id 999 -> 400 INVALID_TOPICS`; `GET returns sorted ids`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `PUT` validates ids against `interest_topics` then delete + insert in one transaction.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: /me, account deletion and interests`.

### Task 9: Server entrypoint, Docker, CI, docs

**Files:**
- Create: `src/server.ts`, `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `README.md`
- Test: `tests/server.test.ts`

**Interfaces:** Produces `startServer(env = process.env): Promise<{ app; stop(): Promise<void> }>`.

- [ ] **Step 1: Write failing test** `startServer with invalid env rejects listing the bad vars`; `stop() closes the app` (inject deps by mocking `createDb` is unnecessary — use an invalid env for the first, and a test-only `buildDeps` override for the second).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: `loadConfig` → `createDb` → real `SupabaseAuthProvider`, `createNotifier`, `createTokenVerifier` → `buildApp` → `listen({ host, port })`. On `SIGTERM`/`SIGINT`: `app.close()` with a 10 s timeout, then `db.close()`, exit 0; uncaught errors logged then exit 1.
- [ ] **Step 4:** Dockerfile: `node:24-alpine` builder (`npm ci`, `npm run build`), runtime stage copies `dist`, `src/db/migrations`, prod `node_modules` (`npm ci --omit=dev`), `USER node`, `EXPOSE 3000`, `HEALTHCHECK` with `wget -qO- localhost:3000/health/live`, `CMD ["node","dist/server.js"]`. Migrations folder path resolved relative to the compiled file.
- [ ] **Step 5:** CI: on push/PR, Node 24, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- [ ] **Step 6:** README: setup, env vars table, Supabase dashboard settings (JWT expiry 900 s, email confirmation on, Google/Azure providers), `npm run db:migrate`, run, test, Docker, and a manual smoke-test checklist (register → email arrives → verify → /me → logout).
- [ ] **Step 7:** Run `npm run lint && npm run typecheck && npm test && npm run build` → all pass.
- [ ] **Step 8:** Commit `chore: server entrypoint, Docker image, CI and README`.

### Task 10: Live smoke test (needs the team's `.env`)

- [ ] **Step 1:** With `.env` filled in (real Supabase + Resend), run `npm run db:migrate:dev`, then `npm run dev`.
- [ ] **Step 2:** Walk the README smoke checklist against `http://localhost:3000/api/v1`. Expected: email with a 4-digit code arrives; verify returns tokens; `/me` returns the user; refresh works; logout then refresh with the old refresh token fails.
- [ ] **Step 3:** Record results in the PR description. Any failure → `superpowers:systematic-debugging`.
