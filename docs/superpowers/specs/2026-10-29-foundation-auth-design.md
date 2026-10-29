# Pipeline Backend — Sub-project 1: Foundation + Auth

Date: 2026-10-29
Status: Draft for review
Source requirements: `Pipeline_Backend_Requirements.docx` (sections 4, 11, Appendix B)

## 1. Goal

Stand up the production-grade API skeleton every later module builds on, and ship the complete
authentication and account flow the mobile app needs to get from Splash to Home:
register, login, OTP verify/resend, token refresh, logout, password reset, Google/Microsoft
sign-in, `/me`, account deletion, and interest selection.

### In scope
- Project scaffold, configuration, logging, error/list envelopes, OpenAPI, security middleware,
  health checks, graceful shutdown, Dockerfile, CI.
- Database access + migrations for the tables this sub-project needs.
- Endpoints listed in section 6.

### Out of scope (later sub-projects)
- LinkedIn sign-in (Supabase has no ID-token flow for LinkedIn; needs a custom OAuth exchange).
- SMS delivery (channel is pluggable; Twilio adapter added when an account exists).
- Profile editing, avatar, settings, XP, subscriptions, notifications — `/me` returns defaults
  for XP, level, subscription and unread count until those modules exist.

## 2. Decisions

| Topic | Decision |
|---|---|
| Language / runtime | TypeScript (strict), Node 24 LTS, ESM |
| Framework | Fastify 5 + `fastify-type-provider-zod` (Zod schemas drive validation and OpenAPI) |
| Data access | Direct Postgres connection to Supabase via `postgres` (postgres.js) + Drizzle ORM; SQL migrations in repo (drizzle-kit) |
| Auth system | Supabase Auth owns users, password hashing, access/refresh tokens (rotation + reuse detection) |
| OTP | Our own 4-digit codes (Supabase OTP is 6–10 digits and uses its own mailer) |
| OTP delivery | Email via Resend for **both** sign-up and login. Notifier interface supports a future SMS channel. `console` driver for local dev only |
| Login OTP | Required on every login by default; `LOGIN_OTP_REQUIRED` config flag |
| Token verification | `jose` against the project JWKS (`/auth/v1/.well-known/jwks.json`); HS256 legacy secret fallback if `SUPABASE_JWT_SECRET` is set |
| Rate limiting | `@fastify/rate-limit`; in-memory by default, Redis when `REDIS_URL` is set (required for >1 instance) |
| Tests | Vitest. Route tests via `app.inject`. DB tests run real migrations on PGlite (embedded Postgres, no Docker) with a stub `auth` schema. Supabase Auth and Resend are faked behind interfaces |
| Deployment | Multi-stage Dockerfile; host-agnostic |

## 3. Architecture

```
src/
  app.ts                 buildApp(deps) — registers plugins and modules; used by server and tests
  server.ts              entrypoint: load config, build deps, listen, graceful shutdown
  config.ts              Zod-validated env; app refuses to boot on invalid config
  lib/
    errors.ts            AppError + error codes; global error handler -> standard error body
    pagination.ts        opaque cursor encode/decode, list envelope helper
    auth-guard.ts        `app.authenticate` preHandler: verifies JWT, sets request.user
    logger.ts            pino options with redaction
    phone.ts             dial code + mobile -> E.164 (libphonenumber-js)
  db/
    client.ts            postgres.js + drizzle instance
    schema.ts            Drizzle table definitions
    migrations/          generated SQL
    migrate.ts           programmatic migrator (runs in the Docker image without dev deps)
  integrations/
    supabase-auth.ts     AuthProvider interface + Supabase implementation
    notifier.ts          Notifier interface; resend + console implementations
  modules/
    auth/   routes.ts  service.ts  otp.ts  schemas.ts
    me/     routes.ts  service.ts  schemas.ts
    interests/ routes.ts service.ts schemas.ts
  plugins/
    security.ts          helmet, cors, rate-limit, request id
    swagger.ts           OpenAPI 3 at /docs and /docs/json
    health.ts            /health/live, /health/ready (DB ping)
```

Each module depends only on `lib`, `db` and `integrations` interfaces; dependencies are injected
through `buildApp(deps)` so tests swap fakes in.

All routes are mounted under `/api/v1`. Health and docs are unversioned.

## 4. Data model (public schema)

All public tables have **RLS enabled with no policies**. The API connects as the `postgres` role
(bypasses RLS); this stops the Supabase anon key / PostgREST from reading these tables directly.

**profiles** — 1:1 with `auth.users`
- `id uuid pk references auth.users(id) on delete cascade`
- `email text not null unique` (lower-cased)
- `full_name text not null`
- `country_name text`, `dial_code text`, `mobile text`, `phone_e164 text`
- `avatar_url text`
- `status text not null` — `pending` | `active`
- `terms_accepted_at timestamptz`, `terms_version text`
- `created_at`, `updated_at timestamptz not null default now()`

**otp_challenges**
- `id uuid pk`
- `user_id uuid references auth.users(id) on delete cascade`
- `purpose text` — `signup` | `login` | `password_reset`
- `channel text` — `email` | `sms`
- `destination text` (email or E.164)
- `code_hash text` — HMAC-SHA256(code, `OTP_SECRET`) — a plain hash of 4 digits is trivially reversible
- `attempts int default 0`, `max_attempts int default 5`
- `resend_count int default 0`
- `expires_at timestamptz`, `resend_available_at timestamptz`, `consumed_at timestamptz`
- `created_ip inet`, `created_at timestamptz`
- index on `(destination, created_at)` for per-identifier rate limiting

**interest_topics** — `id smallserial pk`, `slug text unique`, `name text`, `sort_order int`, `is_active bool`.
Seeded with the 17 topics from Appendix B.

**user_interests** — `user_id uuid references auth.users on delete cascade`, `topic_id smallint references interest_topics`, pk `(user_id, topic_id)`.

## 5. Auth flows

### OTP rules
- 4 numeric digits from `crypto.randomInt`.
- Expires 5 minutes after issue (`OTP_TTL_SECONDS`).
- Max 5 wrong attempts, then the challenge is dead (`OTP_LOCKED`); user must restart.
- Resend: not before 27 s (`OTP_RESEND_SECONDS`), max 5 resends per challenge; each resend issues a new code, resets expiry, keeps attempts.
- Per-destination cap: max 10 challenges per hour.
- Compare with `crypto.timingSafeEqual` on the HMACs.
- Challenge is consumed on success; a consumed challenge cannot be reused.

### Register — `POST /auth/register`
1. Validate body (fullName 1–100, email, countryName, dialCode, mobile → valid E.164, password 8–72 chars, `termsAccepted: true`).
2. If a profile with that email is `active` → `409 EMAIL_TAKEN`.
3. If `pending` → update password and details on the existing Supabase user (lets the real owner reclaim an abandoned registration).
4. Else `admin.createUser({ email, password, email_confirm: false })`, insert profile `pending` with terms timestamp + `TERMS_VERSION`.
5. Create `signup` challenge, email the code. Return `201 { challengeId, channel, destinationMasked, resendAvailableInSec }`.

### Login — `POST /auth/login`
1. Look up profile; a `pending` account → `403 ACCOUNT_NOT_VERIFIED`.
2. Check password with Supabase `signInWithPassword` on a non-persisting client. Wrong email or password → `401 INVALID_CREDENTIALS` (same message for both). The session this creates is revoked immediately.
3. If `LOGIN_OTP_REQUIRED`: create `login` challenge, email code, return `{ otpRequired: true, challengeId, ... }`.
   Otherwise return `{ otpRequired: false, ...tokens }` from the session in step 2 (not revoked in that case).
4. Per-email limit: 10 login attempts / 15 min → `429` (rate-limit keyed on the lower-cased email).

### Verify — `POST /auth/otp/verify`
Body `{ challengeId, code }`. On success:
- `signup`: confirm email in Supabase, set profile `active`.
- Mint a session: `admin.generateLink({ type: 'magiclink', email })` → `verifyOtp({ token_hash, type: 'email' })` returns a real Supabase session.
- Response: `{ accessToken, refreshToken, expiresIn, isNewUser, user }` (`isNewUser` = purpose was `signup`).
- `password_reset` challenges are rejected here (`400 WRONG_CHALLENGE`).

Errors: `400 OTP_INVALID` (with `attemptsRemaining`), `410 OTP_EXPIRED`, `423 OTP_LOCKED`, `404 CHALLENGE_NOT_FOUND`, `409 OTP_ALREADY_USED`. Consumption is a single conditional `UPDATE ... WHERE consumed_at IS NULL`, so a double-tap can never mint two sessions.

### Resend — `POST /auth/otp/resend`
Body `{ challengeId }`. `429 OTP_RESEND_TOO_SOON` with `retryAfterSec` before the cooldown.

### Refresh — `POST /auth/refresh`
Body `{ refreshToken }` → Supabase `refreshSession`. Supabase rotates and detects reuse. Invalid → `401 INVALID_REFRESH_TOKEN`.

### Logout — `POST /auth/logout` (auth)
`admin.signOut(accessToken, 'local')` — revokes this device's session. Access tokens stay valid until expiry (15 min), which is standard for JWTs.

### Forgot / reset password
- `POST /auth/password/forgot { email }` — always `200 { challengeId, ... }`. Unknown or pending emails get a real challenge row with `user_id = null` and no email sent, so resend/reset behave identically but can never succeed (no account enumeration). Real accounts get a `password_reset` code by email.
- `POST /auth/password/reset { challengeId, code, newPassword }` — verify challenge, `admin.updateUserById(password)`, delete all rows in `auth.sessions` for the user (signs out every device). Returns `204`.

### OAuth — `POST /auth/oauth/{provider}`
`provider` ∈ `google`, `microsoft`. Body `{ idToken, nonce? }` → Supabase `signInWithIdToken` (`microsoft` maps to Supabase `azure`). Creates an `active` profile on first sign-in. Returns the same shape as verify. Requires those providers to be enabled in the Supabase dashboard.

## 6. Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /api/v1/auth/register | public | strict rate limit |
| POST | /api/v1/auth/login | public | strict rate limit |
| POST | /api/v1/auth/otp/verify | public | strict rate limit |
| POST | /api/v1/auth/otp/resend | public | strict rate limit |
| POST | /api/v1/auth/refresh | public | |
| POST | /api/v1/auth/logout | bearer | |
| POST | /api/v1/auth/password/forgot | public | strict rate limit |
| POST | /api/v1/auth/password/reset | public | strict rate limit |
| POST | /api/v1/auth/oauth/{provider} | public | google, microsoft |
| GET | /api/v1/me | bearer | user, subscription `{status:"free"}`, `xpTotal: 0`, level `{number:1,name:"Explorer"}`, `unreadNotifications: 0` |
| DELETE | /api/v1/me | bearer | deletes the Supabase user; cascades to all public rows; `204` |
| GET | /api/v1/interests/topics | public | `{ items, nextCursor: null, total }` |
| GET | /api/v1/me/interests | bearer | `{ topicIds }` |
| PUT | /api/v1/me/interests | bearer | `{ topicIds: [≥1 valid ids] }` replaces selection in one transaction |
| GET | /health/live, /health/ready | public | ready pings the DB |
| GET | /docs, /docs/json | public | disabled when `DOCS_ENABLED=false` |

The interests XP award (+5, once) is wired when the XP module lands.

## 7. Cross-cutting

- **Errors:** every error returns `{ "error": { "code", "message", "fields"? } }`. Zod failures → `422 VALIDATION_FAILED` with per-field reasons. Unknown errors → `500 INTERNAL` without internals; logged with request id.
- **Lists:** `{ items, nextCursor, total }`; cursors are opaque base64url.
- **Auth guard:** verifies signature, `iss = {SUPABASE_URL}/auth/v1`, `aud = authenticated`, expiry; then loads the profile and rejects `pending` or missing profiles with `401`.
- **Logging:** pino JSON; redacts `password`, `newPassword`, `code`, `refreshToken`, `accessToken`, `idToken`, `authorization`, cookies. Request id from `x-request-id` or generated; echoed in the response header.
- **Security:** helmet; CORS allow-list from `CORS_ORIGINS` (mobile apps don't need CORS; for the web/admin later); global rate limit 300 req/min/IP, auth routes 10 req/min/IP; body limit 100 KB; `trustProxy` configurable.
- **Shutdown:** on SIGTERM/SIGINT stop accepting, finish in-flight requests (10 s cap), close DB pool.
- **Config (env):** `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET?`, `OTP_SECRET` (≥32 chars), `OTP_TTL_SECONDS=300`, `OTP_RESEND_SECONDS=27`, `LOGIN_OTP_REQUIRED=true`, `NOTIFIER=resend|console`, `RESEND_API_KEY`, `EMAIL_FROM`, `TERMS_VERSION`, `CORS_ORIGINS`, `REDIS_URL?`, `DOCS_ENABLED=true`. In `production`, `NOTIFIER=console` is rejected.

## 8. Testing

- Unit: OTP generation/hash/verify/expiry/lockout/resend, phone normalisation, cursor helpers, config validation.
- Route (via `app.inject`, PGlite DB, fake AuthProvider + Notifier): every endpoint's happy path and its documented error codes, auth guard, rate limiting, error envelope, log redaction.
- Migrations run against PGlite in tests, so schema drift is caught.
- CI (GitHub Actions): `npm ci`, lint (ESLint), typecheck, test, build.
- Not covered by automated tests: real Resend delivery and real Supabase Auth calls — verified with a manual smoke test against the live project once `.env` is filled in.

## 9. Setup required from the team

- `.env` with the Supabase URL (`https://vrckchkooikpvmbinsed.supabase.co`), anon and service-role keys, the database connection string (pooler, session mode), a Resend API key and a verified sending domain.
- Supabase dashboard: JWT expiry 900 s; email confirmation on; Google / Azure providers when OAuth is wanted.
- Run migrations: `npm run db:migrate` (the 17 interest topics are seeded by a data migration, so there is no separate seed step).
