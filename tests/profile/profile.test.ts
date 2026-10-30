import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { profiles } from '../../src/db/schema.js';
import { sniffImage } from '../../src/modules/profile/service.js';
import { createTestApp, signUp, type TestApp } from '../helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);

function multipart(file: Buffer, filename = 'me.jpg', contentType = 'image/jpeg') {
  const boundary = '----pipelinetestboundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('GET /me/profile', () => {
  it('returns sign-up details and 30% completion for a new account', async () => {
    const u = await signUp(t);
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/profile', headers: auth(u.accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: u.userId,
      fullName: 'Adnan Ghaffar',
      email: u.email,
      countryName: 'Pakistan',
      dialCode: '+92',
      mobile: '3001234567',
      location: null,
      expertiseAreas: [],
      completion: {
        percent: 30,
        missingFields: ['location', 'company', 'jobTitle', 'linkedinUrl', 'facebookUrl', 'instagramUrl', 'websiteUrl'],
      },
    });
  });

  it('requires a token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me/profile' })).statusCode).toBe(401);
  });
});

describe('PATCH /me/profile', () => {
  const patch = (token: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url: '/api/v1/me/profile', headers: auth(token), payload: payload as object });

  it('updates fields, normalises URLs and recomputes completion', async () => {
    const u = await signUp(t);
    const res = await patch(u.accessToken, {
      location: 'Lahore',
      company: 'Code Automation',
      jobTitle: 'CTO',
      linkedinUrl: 'linkedin.com/in/adnan',
      facebookUrl: 'https://www.facebook.com/adnan',
      instagramUrl: 'instagram.com/adnan',
      websiteUrl: 'codeautomation.dev',
      expertiseAreas: ['Cloud', 'AI'],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.linkedinUrl).toBe('https://linkedin.com/in/adnan');
    expect(body.websiteUrl).toBe('https://codeautomation.dev/');
    expect(body.expertiseAreas).toEqual(['Cloud', 'AI']);
    expect(body.completion).toEqual({ percent: 100, missingFields: [] });
  });

  it('clears a field with null or an empty string', async () => {
    const u = await signUp(t);
    await patch(u.accessToken, { company: 'Acme', location: 'Lahore' });
    const res = await patch(u.accessToken, { company: null, location: '  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ company: null, location: null });
  });

  it('re-validates the phone when only the mobile changes', async () => {
    const u = await signUp(t);
    const ok = await patch(u.accessToken, { mobile: '03211234567' });
    expect(ok.statusCode).toBe(200);
    const [row] = await t.db.select().from(profiles).where(eq(profiles.id, u.userId));
    expect(row?.phoneE164).toBe('+923211234567');

    const bad = await patch(u.accessToken, { dialCode: '+1', mobile: '12' });
    expect(bad.statusCode).toBe(422);
  });

  it('rejects invalid values with per-field reasons', async () => {
    const u = await signUp(t);
    const res = await patch(u.accessToken, {
      linkedinUrl: 'https://twitter.com/adnan',
      websiteUrl: 'not a url',
      fullName: '',
      expertiseAreas: ['AI', 'ai'],
    });
    expect(res.statusCode).toBe(422);
    const fields = res.json().error.fields;
    expect(Object.keys(fields).sort()).toEqual(['expertiseAreas', 'fullName', 'linkedinUrl', 'websiteUrl']);
  });

  it('refuses an email change', async () => {
    const u = await signUp(t);
    const res = await patch(u.accessToken, { email: 'new@example.com' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields.email).toBe('Email cannot be changed here yet');
  });

  it('rejects an empty body', async () => {
    const u = await signUp(t);
    expect((await patch(u.accessToken, {})).statusCode).toBe(422);
  });
});

describe('settings and contact sharing', () => {
  it('defaults, updates settings and stores contact sharing', async () => {
    const u = await signUp(t);
    const get = () => t.app.inject({ method: 'GET', url: '/api/v1/me/settings', headers: auth(u.accessToken) });
    expect((await get()).json()).toEqual({
      notificationsEnabled: true,
      themePreference: 'system',
      timezone: null,
      showOnLeaderboard: true,
      contactSharing: { enabled: false, email: false, phone: false },
    });

    const upd = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/settings',
      headers: auth(u.accessToken),
      payload: { themePreference: 'dark', notificationsEnabled: false },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ themePreference: 'dark', notificationsEnabled: false });

    const share = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/privacy/contact-sharing',
      headers: auth(u.accessToken),
      payload: { enabled: true, email: true, phone: false },
    });
    expect(share.statusCode).toBe(200);
    expect(share.json()).toEqual({ enabled: true, email: true, phone: false });
    expect((await get()).json().contactSharing).toEqual({ enabled: true, email: true, phone: false });
  });

  it('rejects an unknown theme', async () => {
    const u = await signUp(t);
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me/settings',
      headers: auth(u.accessToken),
      payload: { themePreference: 'blue' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('requires all three contact-sharing flags', async () => {
    const u = await signUp(t);
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/privacy/contact-sharing',
      headers: auth(u.accessToken),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('avatar', () => {
  const upload = (token: string, file: Buffer, ...rest: [string?, string?]) =>
    t.app.inject({ method: 'POST', url: '/api/v1/me/avatar', ...withAuth(multipart(file, ...rest), token) });
  const withAuth = (m: ReturnType<typeof multipart>, token: string) => ({
    payload: m.payload,
    headers: { ...m.headers, ...auth(token) },
  });

  it('uploads, replaces the old file, and shows on /me', async () => {
    const u = await signUp(t);
    const first = await upload(u.accessToken, JPEG);
    expect(first.statusCode).toBe(200);
    const url1 = first.json().avatarUrl as string;
    expect(url1).toMatch(new RegExp(`/avatars/${u.userId}/[0-9a-f-]+\\.jpg$`));
    expect(t.avatars.objects.size).toBeGreaterThan(0);

    const second = await upload(u.accessToken, PNG, 'me.png', 'image/png');
    expect(second.statusCode).toBe(200);
    const url2 = second.json().avatarUrl as string;
    expect(url2).toMatch(/\.png$/);
    const mine = [...t.avatars.objects.keys()].filter((k) => k.startsWith(`${u.userId}/`));
    expect(mine).toHaveLength(1);

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(u.accessToken) });
    expect(me.json().avatarUrl).toBe(url2);
  });

  it('rejects a non-image even when it claims to be a JPEG', async () => {
    const u = await signUp(t);
    const res = await upload(u.accessToken, Buffer.from('<?php echo 1; ?>'));
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects files over 4 MB', async () => {
    const u = await signUp(t);
    const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024 + 1)]);
    const res = await upload(u.accessToken, big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a JSON body', async () => {
    const u = await signUp(t);
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/me/avatar', headers: auth(u.accessToken), payload: { a: 1 } });
    expect(res.statusCode).toBe(415);
  });

  it('reports a storage outage as 503 and keeps the old photo', async () => {
    const u = await signUp(t);
    const ok = await upload(u.accessToken, JPEG);
    t.avatars.failNext();
    const res = await upload(u.accessToken, PNG, 'me.png', 'image/png');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('STORAGE_UNAVAILABLE');
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: auth(u.accessToken) });
    expect(me.json().avatarUrl).toBe(ok.json().avatarUrl);
  });

  it('removes the photo', async () => {
    const u = await signUp(t);
    await upload(u.accessToken, JPEG);
    const res = await t.app.inject({ method: 'DELETE', url: '/api/v1/me/avatar', headers: auth(u.accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ avatarUrl: null });
    expect([...t.avatars.objects.keys()].some((k) => k.startsWith(`${u.userId}/`))).toBe(false);
  });

  it('deletes the photo when the account is deleted', async () => {
    const u = await signUp(t);
    await upload(u.accessToken, JPEG);
    const res = await t.app.inject({ method: 'DELETE', url: '/api/v1/me', headers: auth(u.accessToken) });
    expect(res.statusCode).toBe(204);
    expect([...t.avatars.objects.keys()].some((k) => k.startsWith(`${u.userId}/`))).toBe(false);
  });
});

describe('sniffImage', () => {
  it('detects jpeg, png and webp only', () => {
    expect(sniffImage(JPEG)?.mime).toBe('image/jpeg');
    expect(sniffImage(PNG)?.mime).toBe('image/png');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]);
    expect(sniffImage(webp)?.mime).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a........'))).toBeNull();
  });
});

describe('auth before validation', () => {
  it.each([
    ['PATCH', '/api/v1/me/profile'],
    ['PATCH', '/api/v1/me/settings'],
    ['PUT', '/api/v1/me/privacy/contact-sharing'],
    ['PUT', '/api/v1/me/interests'],
  ] as const)('%s %s without a token is 401 even with a bad body', async (method, url) => {
    const res = await t.app.inject({ method, url, payload: { nonsense: true } });
    expect(res.statusCode).toBe(401);
  });
});
