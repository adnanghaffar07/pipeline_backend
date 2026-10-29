# Pipeline Backend

REST API for the Pipeline mobile app (Pipeline Magazine, pipelinepub.com). Node 24, TypeScript, Fastify 5,
Supabase (Postgres + Auth), Resend for email.

- Spec: `docs/superpowers/specs/2026-10-29-foundation-auth-design.md`
- API docs (when `DOCS_ENABLED=true`): `GET /docs` (Swagger UI), `GET /docs/json` (OpenAPI 3 — the mobile team can mock from it)

## What's implemented

| Area | Endpoints (all under `/api/v1`) |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/otp/verify`, `/auth/otp/resend`, `/auth/refresh`, `/auth/logout`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/oauth/{google\|microsoft}` |
| Account | `GET /me`, `DELETE /me` |
| Interests | `GET /interests/topics`, `GET /me/interests`, `PUT /me/interests` |
| Ops | `GET /health/live`, `GET /health/ready` (unversioned) |

### How sign-in works

1. `register` (or `login`) checks the details and emails a **4-digit code**; it returns a `challengeId`.
2. `otp/verify` with `challengeId` + `code` returns `accessToken` (15 min), `refreshToken`, `isNewUser` and the user.
3. Send `Authorization: Bearer <accessToken>` on protected calls; use `auth/refresh` when it expires. Refresh tokens rotate — always store the newest one.

Codes expire after 5 minutes, allow 5 wrong attempts, can be resent after 27 seconds (max 5 times), and a single
address can request at most 10 per hour. `LOGIN_OTP_REQUIRED=false` makes login return tokens directly.

Errors always look like `{ "error": { "code": "OTP_INVALID", "message": "...", "fields"?: {...} } }`.
Lists look like `{ "items": [], "nextCursor": null, "total": 0 }`.

## Setup

```bash
npm ci
cp .env.example .env   # then fill it in — see below
npm run db:migrate:dev # creates tables and seeds the 17 interest topics
npm run dev            # http://localhost:3000/docs
```

### Environment

Every variable is documented in `.env.example`. The app refuses to start if any is missing or invalid, and in
production it refuses `NOTIFIER=console`.

- `DATABASE_URL` — Supabase → Project Settings → Database → Connection string (Session pooler).
- `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API keys. The service-role key is a full-access secret: server only, never in the app.
- `SUPABASE_JWT_SECRET` — leave empty on projects using JWT signing keys (tokens are then verified via the project JWKS). Set it only for legacy HS256 projects.
- `OTP_SECRET` — 32+ random characters; changing it invalidates codes in flight.
- `RESEND_API_KEY`, `EMAIL_FROM` — the `EMAIL_FROM` domain must be verified in Resend.
- `REDIS_URL` — required when running more than one instance, so rate limits are shared.

### Supabase dashboard settings

- Authentication → Sign In / Providers → Email: enabled, **Confirm email on**.
- Authentication → Sessions / JWT: access token expiry **900** seconds; refresh token rotation and reuse detection on (default).
- Google / Azure providers: enable and add the mobile app's client IDs when OAuth sign-in is wanted.
- All our tables have row-level security on with no policies: the anon key cannot read them through the Supabase REST API. Only this server (direct Postgres connection) can.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Full test suite (in-process Postgres via PGlite; Supabase and Resend are faked) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `npm run db:migrate:dev` / `npm run db:migrate` | Apply migrations (source / compiled) |

## Docker

```bash
docker build -t pipeline-backend .
docker run --rm --env-file .env pipeline-backend node dist/db/migrate.js   # release step
docker run -d --env-file .env -p 3000:3000 pipeline-backend
```

The container runs as a non-root user, exposes a health check on `/health/live`, and shuts down gracefully on
`SIGTERM` (in-flight requests get up to 10 s). Set `TRUST_PROXY=true` behind a load balancer so rate limits see
real client IPs.

## Manual smoke test (real Supabase + Resend)

Not covered by automated tests; run once per environment.

1. `POST /api/v1/auth/register` with your own email → 201 and an email with a 4-digit code arrives.
2. `POST /api/v1/auth/otp/verify` → 200 with tokens, `isNewUser: true`.
3. `GET /api/v1/me` with the access token → your profile.
4. `PUT /api/v1/me/interests` `{ "topicIds": [1, 2] }` → 200.
5. `POST /api/v1/auth/refresh` → new tokens; the old refresh token now fails.
6. `POST /api/v1/auth/logout` → 204; refreshing with the latest refresh token now fails.
7. `POST /api/v1/auth/login` → code email → verify → `isNewUser: false`.
8. `POST /api/v1/auth/password/forgot` → reset email → `POST /api/v1/auth/password/reset` → 204; old password rejected.
9. `DELETE /api/v1/me` → 204; the user is gone from Supabase → Authentication → Users.

## Not yet built

LinkedIn sign-in, SMS delivery (the notifier has an `sms` channel slot), and everything outside sections 4 and 11
of the requirements doc (content, library, XP, profile editing, notifications, subscriptions, ads) — those are
later sub-projects. `/me` returns `xpTotal: 0`, level 1 "Explorer", `subscription.status: "free"` and
`unreadNotifications: 0` until those modules exist.
