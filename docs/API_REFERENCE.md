# Pipeline Mobile API — Reference for App Developers

**Base URL:** `https://pipeline-backend-tan.vercel.app`
**Version prefix:** all app endpoints are under `/api/v1`
**Interactive docs:** https://pipeline-backend-tan.vercel.app/docs (Swagger UI) · OpenAPI JSON: https://pipeline-backend-tan.vercel.app/docs/json

---

## 1. General rules

| Rule | Detail |
|---|---|
| Content type | Send `Content-Type: application/json` on every request that has a body. Max body size 100 KB. |
| Auth | Protected endpoints need `Authorization: Bearer <accessToken>`. |
| Access token life | 15 minutes (`expiresIn: 900` seconds). Refresh with `POST /api/v1/auth/refresh`. |
| Refresh tokens | **Rotate on every refresh.** Always save the newest `refreshToken` and throw away the old one — an old one stops working. |
| Emails | Trimmed and lower-cased by the server. |
| Request id | Every response has an `x-request-id` header. Include it in bug reports. |
| Rate limits | 300 requests/min per IP overall; auth endpoints 10/min per IP; login 10 attempts / 15 min per email. Over the limit → `429 RATE_LIMITED` (may include a `Retry-After` header). |

### Error format (all errors)

```json
{
  "error": {
    "code": "OTP_INVALID",
    "message": "The code is incorrect",
    "attemptsRemaining": 3
  }
}
```

- Always switch on `error.code`, not the message. `message` is human-readable and safe to show.
- Some errors add extra fields next to `code`/`message` (e.g. `attemptsRemaining`, `retryAfterSec`, `invalidIds`).
- Validation errors (`422 VALIDATION_FAILED`) include `fields`, a map of field name → reason, ready to show under each form input:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "fields": {
      "email": "Enter a valid email address",
      "password": "Password must be at least 8 characters"
    }
  }
}
```

### List format

```json
{ "items": [], "nextCursor": null, "total": 0 }
```

### The `user` object (returned by verify, OAuth, login and `/me`)

```json
{
  "id": "3f6c1a2e-8b1d-4c3a-9a51-1f0d2b7e9c44",
  "fullName": "Adnan Ghaffar",
  "email": "adnan@example.com",
  "avatarUrl": null,
  "xpTotal": 0,
  "level": { "number": 1, "name": "Explorer" },
  "subscription": { "status": "free" }
}
```

`subscription.status` is one of `free`, `active`, `grace`, `expired`, `canceled`. For now `xpTotal` is always `0`, `level` is always `1 / Explorer` and `subscription` is always `free`. These will change once those features are built.

---

## 2. Sign-in flows (how the screens connect)

### Sign up
1. `POST /auth/register` → returns `challengeId`, and a **4-digit code** is emailed to the user.
2. Show the OTP screen. `POST /auth/otp/verify` with `challengeId` + `code` → returns tokens + `user`, with `isNewUser: true`.
3. Send new users to interest selection: `GET /interests/topics`, then `PUT /me/interests`.

### Log in
1. `POST /auth/login` → check `otpRequired`:
   - `true`: a code was emailed. Go to the OTP screen, then `POST /auth/otp/verify` (`isNewUser: false`).
   - `false`: tokens are already in the response. Go straight to Home.
2. If login returns `403 ACCOUNT_NOT_VERIFIED`, the user signed up but never entered the code. Call `register` again with the same email to get a new code.

### Forgot password
1. `POST /auth/password/forgot` → always returns a `challengeId`, even for unknown emails (on purpose, so nobody can check which emails have accounts).
2. `POST /auth/password/reset` with `challengeId` + `code` + `newPassword` → `204`. The user is signed out on every device and must log in again.

### OTP rules (for the OTP screen UI)
- 4 digits, valid for **5 minutes**.
- **5 wrong tries** and the code is dead (`423 OTP_LOCKED`). Send the user back to the start of the flow.
- Resend is allowed after `resendAvailableInSec` seconds (27). Show a countdown. Max 5 resends per challenge. Each resend sends a new code and resets the 5 minutes.
- Max 10 codes per email per hour for each purpose.

### Token handling
- Store `accessToken` and `refreshToken` in secure storage (Keychain / Keystore).
- On `401 UNAUTHORIZED` from a protected call, call `/auth/refresh` once and retry. If refresh returns `401 INVALID_REFRESH_TOKEN`, clear tokens and show Login.
- Don't run two refreshes at the same time. Refresh tokens rotate, so a second parallel refresh will use a token that is already spent.

---

## 3. Endpoints

| # | Method | Path | Auth | Success |
|---|---|---|---|---|
| 3.1 | POST | `/api/v1/auth/register` | — | 201 |
| 3.2 | POST | `/api/v1/auth/login` | — | 200 |
| 3.3 | POST | `/api/v1/auth/otp/verify` | — | 200 |
| 3.4 | POST | `/api/v1/auth/otp/resend` | — | 200 |
| 3.5 | POST | `/api/v1/auth/refresh` | — | 200 |
| 3.6 | POST | `/api/v1/auth/logout` | Bearer | 204 |
| 3.7 | POST | `/api/v1/auth/password/forgot` | — | 200 |
| 3.8 | POST | `/api/v1/auth/password/reset` | — | 204 |
| 3.9 | POST | `/api/v1/auth/oauth/{provider}` | — | 200 |
| 3.10 | GET | `/api/v1/me` | Bearer | 200 |
| 3.11 | DELETE | `/api/v1/me` | Bearer | 204 |
| 3.12 | GET | `/api/v1/interests/topics` | — | 200 |
| 3.13 | GET | `/api/v1/me/interests` | Bearer | 200 |
| 3.14 | PUT | `/api/v1/me/interests` | Bearer | 200 |
| 3.15 | GET | `/health/live`, `/health/ready` | — | 200 |
| 3.16 | GET | `/api/v1/me/profile` | Bearer | 200 |
| 3.17 | PATCH | `/api/v1/me/profile` | Bearer | 200 |
| 3.18 | POST | `/api/v1/me/avatar` | Bearer | 200 |
| 3.19 | DELETE | `/api/v1/me/avatar` | Bearer | 200 |
| 3.20 | GET | `/api/v1/me/settings` | Bearer | 200 |
| 3.21 | PATCH | `/api/v1/me/settings` | Bearer | 200 |
| 3.22 | PUT | `/api/v1/me/privacy/contact-sharing` | Bearer | 200 |

---

### 3.1 Register — `POST /api/v1/auth/register`

Creates the account and emails a 4-digit code.

**Body**

```json
{
  "fullName": "Adnan Ghaffar",
  "email": "adnan@example.com",
  "countryName": "Pakistan",
  "dialCode": "+92",
  "mobile": "3001234567",
  "password": "StrongPass123",
  "termsAccepted": true
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `fullName` | string | yes | 1–100 characters |
| `email` | string | yes | valid email, max 254 |
| `countryName` | string | yes | 1–100 characters |
| `dialCode` | string | yes | `+` then 1–4 digits, e.g. `+92`, `+1`, `+44` |
| `mobile` | string | yes | 4–20 characters, national number. A leading `0` is fine. Must be a valid number for the dial code. |
| `password` | string | yes | 8–72 characters |
| `termsAccepted` | boolean | yes | must be `true` |

**Response `201`**

```json
{
  "challengeId": "0b8e4a7c-2d5f-4e1a-9c3b-7f6d5e4c3b2a",
  "channel": "email",
  "destinationMasked": "a***n@example.com",
  "resendAvailableInSec": 27
}
```

**Errors:** `409 EMAIL_TAKEN` (email already has an active account), `422 VALIDATION_FAILED` (including `fields.mobile` for an invalid phone or `fields.password` for a too-weak password), `429 OTP_RATE_LIMITED`, `503 EMAIL_DELIVERY_FAILED`.

> If the email is registered but never verified, calling register again updates the details and sends a new code. Any earlier code stops working.

---

### 3.2 Login — `POST /api/v1/auth/login`

**Body**

```json
{
  "email": "adnan@example.com",
  "password": "StrongPass123"
}
```

**Response `200`, code needed (default):**

```json
{
  "otpRequired": true,
  "challengeId": "0b8e4a7c-2d5f-4e1a-9c3b-7f6d5e4c3b2a",
  "channel": "email",
  "destinationMasked": "a***n@example.com",
  "resendAvailableInSec": 27
}
```

**Response `200`, no code needed (only if the server turns off login codes):**

```json
{
  "otpRequired": false,
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "v1.MrX9...",
  "expiresIn": 900,
  "isNewUser": false,
  "user": { "...": "see User object" }
}
```

Handle both shapes. Branch on `otpRequired`.

**Errors:** `401 INVALID_CREDENTIALS` (wrong email or password, same message for both), `403 ACCOUNT_NOT_VERIFIED`, `429 RATE_LIMITED` (includes `retryAfterSec`), `429 OTP_RATE_LIMITED`, `503 EMAIL_DELIVERY_FAILED`, `503 AUTH_PROVIDER_UNAVAILABLE`.

---

### 3.3 Verify OTP — `POST /api/v1/auth/otp/verify`

Used after **register** and **login** only. Password-reset codes go to 3.8.

**Body**

```json
{
  "challengeId": "0b8e4a7c-2d5f-4e1a-9c3b-7f6d5e4c3b2a",
  "code": "4821"
}
```

| Field | Rules |
|---|---|
| `challengeId` | from register / login / resend |
| `code` | exactly 4 digits, **as a string** (keeps leading zeros like `"0412"`) |

**Response `200`**

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "v1.MrX9...",
  "expiresIn": 900,
  "isNewUser": true,
  "user": {
    "id": "3f6c1a2e-8b1d-4c3a-9a51-1f0d2b7e9c44",
    "fullName": "Adnan Ghaffar",
    "email": "adnan@example.com",
    "avatarUrl": null,
    "xpTotal": 0,
    "level": { "number": 1, "name": "Explorer" },
    "subscription": { "status": "free" }
  }
}
```

`isNewUser: true` → show interest selection. `false` → go to Home.

**Errors**

| Status | Code | What to do |
|---|---|---|
| 400 | `OTP_INVALID` | Wrong code. Show `attemptsRemaining`. |
| 400 | `WRONG_CHALLENGE` | This challenge is a password-reset one. Use 3.8. |
| 404 | `CHALLENGE_NOT_FOUND` | Unknown challenge. Restart the flow. |
| 409 | `OTP_ALREADY_USED` | Already verified (e.g. a double tap). |
| 410 | `OTP_EXPIRED` | Offer "Resend code". |
| 423 | `OTP_LOCKED` | Too many wrong tries. Restart the flow. |
| 422 | `VALIDATION_FAILED` | Code isn't 4 digits. |

---

### 3.4 Resend OTP — `POST /api/v1/auth/otp/resend`

Works for sign-up, login and password-reset challenges.

**Body**

```json
{ "challengeId": "0b8e4a7c-2d5f-4e1a-9c3b-7f6d5e4c3b2a" }
```

**Response `200`:** same shape as register (`challengeId`, `channel`, `destinationMasked`, `resendAvailableInSec`).

**Errors:** `429 OTP_RESEND_TOO_SOON` (has `retryAfterSec`), `429 OTP_RATE_LIMITED` (resend limit reached, restart the flow), `404 CHALLENGE_NOT_FOUND`, `409 OTP_ALREADY_USED`, `423 OTP_LOCKED`, `503 EMAIL_DELIVERY_FAILED`.

---

### 3.5 Refresh token — `POST /api/v1/auth/refresh`

**Body**

```json
{ "refreshToken": "v1.MrX9..." }
```

**Response `200`**

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "v1.NewToken...",
  "expiresIn": 900
}
```

Save **both** new tokens.

**Errors:** `401 INVALID_REFRESH_TOKEN` → sign the user out locally and show Login. `503 AUTH_PROVIDER_UNAVAILABLE` → temporary, retry later. Don't sign the user out.

---

### 3.6 Logout — `POST /api/v1/auth/logout` 🔒

**Headers:** `Authorization: Bearer <accessToken>`
**Body:** none.
**Response:** `204 No Content`.

Signs out this device only. Clear stored tokens on the app side too. The access token keeps working for up to 15 minutes, which is normal for JWTs.

---

### 3.7 Forgot password — `POST /api/v1/auth/password/forgot`

**Body**

```json
{ "email": "adnan@example.com" }
```

**Response `200`:** same shape as register (`challengeId`, `channel`, `destinationMasked`, `resendAvailableInSec`). It always succeeds, even when the email has no account.

**Errors:** `422 VALIDATION_FAILED`, `429 OTP_RATE_LIMITED`, `503 EMAIL_DELIVERY_FAILED`.

---

### 3.8 Reset password — `POST /api/v1/auth/password/reset`

**Body**

```json
{
  "challengeId": "0b8e4a7c-2d5f-4e1a-9c3b-7f6d5e4c3b2a",
  "code": "4821",
  "newPassword": "NewStrongPass123"
}
```

`newPassword`: 8–72 characters.

**Response:** `204 No Content`. Every session is signed out. Send the user to Login.

**Errors:** same OTP errors as 3.3 (`OTP_INVALID`, `OTP_EXPIRED`, `OTP_LOCKED`, `OTP_ALREADY_USED`, `CHALLENGE_NOT_FOUND`), plus `400 WRONG_CHALLENGE` if a sign-up/login challenge is used, and `422 VALIDATION_FAILED` for a weak password.

---

### 3.9 Social sign-in — `POST /api/v1/auth/oauth/{provider}`

`provider` = `google` or `microsoft`.

Sign in with the platform's native Google / Microsoft SDK on the device, take the **ID token**, and send it here.

**Body**

```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs...",
  "nonce": "optional-raw-nonce"
}
```

| Field | Required | Notes |
|---|---|---|
| `idToken` | yes | ID token from the Google / Microsoft SDK |
| `nonce` | no | Only if you passed a nonce to the SDK. Send the **raw** (unhashed) nonce. |

**Response `200`:** same as Verify OTP (tokens + `user` + `isNewUser`). No OTP step.

**Errors:** `401 UNAUTHORIZED` (token rejected), `409 EMAIL_TAKEN` (that email already signed up with a password; tell the user to sign in with their password), `503 AUTH_PROVIDER_UNAVAILABLE`.

> The backend team needs to add the app's Google / Microsoft client IDs in Supabase before this works. Check with them first.

---

### 3.10 Get current user — `GET /api/v1/me` 🔒

**Headers:** `Authorization: Bearer <accessToken>`

**Response `200`**

```json
{
  "id": "3f6c1a2e-8b1d-4c3a-9a51-1f0d2b7e9c44",
  "fullName": "Adnan Ghaffar",
  "email": "adnan@example.com",
  "avatarUrl": null,
  "xpTotal": 0,
  "level": { "number": 1, "name": "Explorer" },
  "subscription": { "status": "free" },
  "unreadNotifications": 0
}
```

Call this on app launch to check the session and load the profile.

**Errors:** `401 UNAUTHORIZED` (missing/expired token, or the account was deleted).

---

### 3.11 Delete account — `DELETE /api/v1/me` 🔒

**Headers:** `Authorization: Bearer <accessToken>`
**Response:** `204 No Content`. The account and all its data are permanently deleted. Clear local storage and go to the welcome screen.

---

### 3.12 Interest topics — `GET /api/v1/interests/topics`

Public. No token needed.

**Response `200`** (current live data)

```json
{
  "items": [
    { "id": 1,  "name": "Network Transformation" },
    { "id": 2,  "name": "Mobile and Wireless" },
    { "id": 3,  "name": "Digital Customer Experience" },
    { "id": 4,  "name": "Innovation" },
    { "id": 5,  "name": "Automation and Support Systems (OSS/BSS)" },
    { "id": 6,  "name": "IoT and Robotics" },
    { "id": 7,  "name": "AI, Automation and Analytics" },
    { "id": 8,  "name": "Digital Transformation" },
    { "id": 9,  "name": "Testing and Assurance" },
    { "id": 10, "name": "Network Evolution and Optimization" },
    { "id": 11, "name": "5G and 6G" },
    { "id": 12, "name": "Top Technology Trends" },
    { "id": 13, "name": "Cloud and Edge" },
    { "id": 14, "name": "Quantum Computing" },
    { "id": 15, "name": "Security and Assurance" },
    { "id": 16, "name": "Enterprise Voice and AI CX" },
    { "id": 17, "name": "Operational Agility" }
  ],
  "nextCursor": null,
  "total": 17
}
```

Always load the list from this endpoint. Don't hard-code it.

---

### 3.13 Get my interests — `GET /api/v1/me/interests` 🔒

**Response `200`**

```json
{ "topicIds": [1, 2, 7] }
```

Empty array if none are selected yet.

---

### 3.14 Save my interests — `PUT /api/v1/me/interests` 🔒

Replaces the whole selection. Send the full list each time, not only the changes.

**Body**

```json
{ "topicIds": [1, 2, 7] }
```

Rules: at least 1, at most 50, unique, positive integer ids from 3.12.

**Response `200`**

```json
{ "topicIds": [1, 2, 7] }
```

**Errors:** `400 INVALID_TOPICS` (includes `invalidIds`), `422 VALIDATION_FAILED` (empty list or duplicates).

---

### 3.15 Health — `GET /health/live`, `GET /health/ready`

Not under `/api/v1`. `live` → `{ "status": "ok" }`. `ready` → `{ "status": "ok", "db": "ok" }` (or `503` when the database is down). Useful for a "server is down" check.

---

## Profile and settings

### 3.16 Get profile — `GET /api/v1/me/profile` 🔒

All Personal Information fields, plus the profile completion banner data.

**Response `200`**

```json
{
  "id": "3f6c1a2e-8b1d-4c3a-9a51-1f0d2b7e9c44",
  "fullName": "Adnan Ghaffar",
  "email": "adnan@example.com",
  "avatarUrl": null,
  "countryName": "Pakistan",
  "dialCode": "+92",
  "mobile": "3001234567",
  "location": null,
  "company": null,
  "jobTitle": null,
  "linkedinUrl": null,
  "facebookUrl": null,
  "instagramUrl": null,
  "websiteUrl": null,
  "expertiseAreas": [],
  "completion": {
    "percent": 30,
    "missingFields": ["location", "company", "jobTitle", "linkedinUrl", "facebookUrl", "instagramUrl", "websiteUrl"]
  }
}
```

`completion.percent` is based on 10 equally weighted fields: fullName, email, mobile, location, company, jobTitle, linkedinUrl, facebookUrl, instagramUrl and websiteUrl. A new account starts at 30%. `missingFields` lists what is still empty, so you can highlight those inputs.

---

### 3.17 Update profile — `PATCH /api/v1/me/profile` 🔒

Send **only the fields you want to change**. At least one field is required. Returns the full updated profile (same shape as 3.16).

**Body (all fields optional)**

```json
{
  "fullName": "Adnan Ghaffar",
  "countryName": "Pakistan",
  "dialCode": "+92",
  "mobile": "3001234567",
  "location": "Lahore",
  "company": "Code Automation",
  "jobTitle": "CTO",
  "linkedinUrl": "linkedin.com/in/adnan",
  "facebookUrl": "https://facebook.com/adnan",
  "instagramUrl": "instagram.com/adnan",
  "websiteUrl": "codeautomation.dev",
  "expertiseAreas": ["Cloud", "AI", "5G"]
}
```

| Field | Rules |
|---|---|
| `fullName` | 1–100 characters. Can't be cleared. |
| `countryName`, `location`, `company`, `jobTitle` | max 100 characters |
| `dialCode` | `+` then 1–4 digits |
| `mobile` | 4–20 characters. Checked against the dial code (the saved one if you send only `mobile`). Can't be cleared. |
| `linkedinUrl` | must be a linkedin.com link |
| `facebookUrl` | must be a facebook.com (or fb.com) link |
| `instagramUrl` | must be an instagram.com link |
| `websiteUrl` | any http/https website |
| `expertiseAreas` | array of up to 20 strings, each 1–50 characters, no duplicates. Send the whole list each time. |
| `email` | **can't be changed yet.** Sending it returns `422` with `fields.email`. |

- **Clearing a field:** send `null` or `""` (works for countryName, location, company, jobTitle and the four URL fields).
- **URLs:** `https://` is optional. `linkedin.com/in/adnan` is saved as `https://linkedin.com/in/adnan`. Show the value the server returns.

**Errors:** `422 VALIDATION_FAILED`, with a reason for each field in `fields`.

---

### 3.18 Upload profile photo — `POST /api/v1/me/avatar` 🔒

"Change Photo". Send the image as **`multipart/form-data`** with one file field (any field name, e.g. `photo`).

- Allowed: **JPEG, PNG or WebP**, max **4 MB**. The server checks the actual file content, not the file name. On iOS, convert HEIC to JPEG before uploading (most image pickers can do this).
- Resize to around 512×512 before uploading for faster uploads. The server stores the image as-is.

```bash
curl -X POST https://pipeline-backend-tan.vercel.app/api/v1/me/avatar \
  -H "Authorization: Bearer <accessToken>" \
  -F "photo=@me.jpg;type=image/jpeg"
```

React Native (`fetch`):

```js
const form = new FormData();
form.append('photo', { uri: image.uri, name: 'avatar.jpg', type: 'image/jpeg' });
await fetch(`${BASE_URL}/api/v1/me/avatar`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` }, // don't set Content-Type; fetch adds the boundary
  body: form,
});
```

**Response `200`**

```json
{ "avatarUrl": "https://<project>.supabase.co/storage/v1/object/public/avatars/<userId>/<random>.jpg" }
```

Each upload gets a new URL and the old photo is deleted, so caching images by URL is safe. `/me` and `/me/profile` return the new `avatarUrl` straight away.

**Errors:** `415 UNSUPPORTED_MEDIA_TYPE` (not an image, or not sent as multipart), `413 PAYLOAD_TOO_LARGE` (over 4 MB), `400 BAD_REQUEST` (no file attached), `429 RATE_LIMITED` (max 10 uploads per minute), `503 STORAGE_UNAVAILABLE` (retry; the old photo is kept).

---

### 3.19 Remove profile photo — `DELETE /api/v1/me/avatar` 🔒

**Response `200`:** `{ "avatarUrl": null }`. Show initials instead.

---

### 3.20 Get settings — `GET /api/v1/me/settings` 🔒

**Response `200`**

```json
{
  "notificationsEnabled": true,
  "themePreference": "system",
  "contactSharing": { "enabled": false, "email": false, "phone": false }
}
```

`themePreference` is `light`, `dark` or `system`. Show `system` as **Default** in the Appearance Mode card. New accounts start with notifications on, theme `system` and contact sharing off.

---

### 3.21 Update settings — `PATCH /api/v1/me/settings` 🔒

Send one or both fields.

```json
{ "notificationsEnabled": false, "themePreference": "dark" }
```

**Response `200`:** the full settings object (same as 3.20).

> Push notifications are not live yet. For now this only saves the toggle. When the notifications module ships, turning it off will also unregister the device.

---

### 3.22 Contact sharing — `PUT /api/v1/me/privacy/contact-sharing` 🔒

Controls whether connected members can see your email and phone. All three fields are **required** on every call.

```json
{ "enabled": true, "email": true, "phone": false }
```

**Response `200`:** `{ "enabled": true, "email": true, "phone": false }`

The master switch behaviour (turning `email` and `phone` on or off with it) is up to the app; the server saves exactly what you send. Later, when networking ships, the rule is: a connected member sees your email only if `enabled` **and** `email` are both true, and the same for phone.

---

## 4. All error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed request (e.g. invalid JSON) |
| 400 | `OTP_INVALID` | Wrong code (`attemptsRemaining`) |
| 400 | `WRONG_CHALLENGE` | Challenge used on the wrong endpoint |
| 400 | `INVALID_TOPICS` | Unknown topic ids (`invalidIds`) |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired access token, or OAuth token rejected |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token expired/used. Sign in again. |
| 403 | `ACCOUNT_NOT_VERIFIED` | Sign-up not finished |
| 404 | `NOT_FOUND` | Route doesn't exist |
| 404 | `CHALLENGE_NOT_FOUND` | Unknown challenge id |
| 409 | `EMAIL_TAKEN` | Email already registered |
| 409 | `OTP_ALREADY_USED` | Code already used |
| 410 | `OTP_EXPIRED` | Code expired |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 100 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Missing/wrong `Content-Type` |
| 422 | `VALIDATION_FAILED` | Field errors in `fields` |
| 423 | `OTP_LOCKED` | Too many wrong codes |
| 429 | `RATE_LIMITED` | Too many requests (`retryAfterSec` on login) |
| 429 | `OTP_RESEND_TOO_SOON` | Wait `retryAfterSec` before resending |
| 429 | `OTP_RATE_LIMITED` | Too many codes requested |
| 500 | `INTERNAL` | Server error. Report it with the `x-request-id`. |
| 503 | `EMAIL_DELIVERY_FAILED` | Email couldn't be sent. Retry shortly. |
| 503 | `AUTH_PROVIDER_UNAVAILABLE` | Auth service temporarily down. Retry. |
| 503 | `STORAGE_UNAVAILABLE` | Photo storage temporarily down. Retry. |

---

## 5. Quick test with curl

```bash
curl -X POST https://pipeline-backend-tan.vercel.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"adnan@example.com","password":"StrongPass123"}'
```

```bash
curl https://pipeline-backend-tan.vercel.app/api/v1/me \
  -H "Authorization: Bearer <accessToken>"
```

## 6. Not built yet

LinkedIn sign-in, SMS codes, changing email, content/library, XP, notifications, subscriptions and ads. These endpoints will be added in later releases. Until then `/me` returns placeholder values for XP, level, subscription and unread count.
