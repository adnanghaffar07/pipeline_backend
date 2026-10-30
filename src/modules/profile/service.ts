import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client.js';
import { profiles } from '../../db/schema.js';
import type { AvatarStorage } from '../../integrations/avatar-storage.js';
import { AppError } from '../../lib/errors.js';
import { toE164 } from '../../lib/phone.js';
import { XpEngine, type AwardInput } from '../xp/engine.js';
import type { ProfilePatch, contactSharing, profileResponse, settingsPatchBody, settingsResponse } from './schemas.js';

type Profile = typeof profiles.$inferSelect;

/** The ten equally weighted fields behind the completion percentage (requirements 9.1). */
const COMPLETION_FIELDS = [
  'fullName',
  'email',
  'mobile',
  'location',
  'company',
  'jobTitle',
  'linkedinUrl',
  'facebookUrl',
  'instagramUrl',
  'websiteUrl',
] as const;

export function completion(p: Profile) {
  const missingFields = COMPLETION_FIELDS.filter((f) => !p[f]);
  const filled = COMPLETION_FIELDS.length - missingFields.length;
  return { percent: Math.round((filled / COMPLETION_FIELDS.length) * 100), missingFields: [...missingFields] };
}

function toProfileView(p: Profile): z.infer<typeof profileResponse> {
  return {
    id: p.id,
    fullName: p.fullName,
    email: p.email,
    avatarUrl: p.avatarUrl,
    countryName: p.countryName,
    dialCode: p.dialCode,
    mobile: p.mobile,
    location: p.location,
    company: p.company,
    jobTitle: p.jobTitle,
    linkedinUrl: p.linkedinUrl,
    facebookUrl: p.facebookUrl,
    instagramUrl: p.instagramUrl,
    websiteUrl: p.websiteUrl,
    expertiseAreas: p.expertiseAreas,
    completion: completion(p),
  };
}

function toSettingsView(p: Profile): z.infer<typeof settingsResponse> {
  return {
    notificationsEnabled: p.notificationsEnabled,
    themePreference: p.themePreference,
    contactSharing: { enabled: p.shareContactEnabled, email: p.shareEmail, phone: p.sharePhone },
  };
}

/** Detects the real image type from its first bytes; the client's content-type header is not trusted. */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export class ProfileService {
  private readonly xp: XpEngine;

  constructor(
    private readonly db: Db,
    private readonly avatars: AvatarStorage,
  ) {
    this.xp = new XpEngine(db);
  }

  private async load(userId: string): Promise<Profile> {
    const [p] = await this.db.select().from(profiles).where(eq(profiles.id, userId));
    if (!p) throw new AppError('UNAUTHORIZED', 'Account not found or not active');
    return p;
  }

  private async save(userId: string, patch: Partial<typeof profiles.$inferInsert>): Promise<Profile> {
    const [p] = await this.db.update(profiles).set(patch).where(eq(profiles.id, userId)).returning();
    if (!p) throw new AppError('UNAUTHORIZED', 'Account not found or not active');
    return p;
  }

  async getProfile(userId: string) {
    return toProfileView(await this.load(userId));
  }

  async updateProfile(userId: string, body: ProfilePatch) {
    const { email: _email, dialCode, mobile, ...rest } = body;
    const patch: Partial<typeof profiles.$inferInsert> = { ...rest };

    if (dialCode !== undefined || mobile !== undefined) {
      // Either half can change alone; the phone number is re-validated against the other half.
      const current = await this.load(userId);
      const nextDial = dialCode ?? current.dialCode;
      const nextMobile = mobile ?? current.mobile;
      if (!nextDial || !nextMobile) {
        throw new AppError('VALIDATION_FAILED', 'Request validation failed', {
          fields: { [nextDial ? 'mobile' : 'dialCode']: 'Send both dialCode and mobile' },
        });
      }
      patch.dialCode = nextDial;
      patch.mobile = nextMobile;
      patch.phoneE164 = toE164(nextDial, nextMobile);
    }

    const saved = await this.save(userId, patch);
    return { ...toProfileView(saved), xpAwarded: await this.awardProfileXp(saved) };
  }

  /** Each profile milestone pays once, ever; clearing and re-filling a field earns nothing more. */
  private async awardProfileXp(p: Profile): Promise<number> {
    const inputs: AwardInput[] = [];
    const once = (type: AwardInput['type'], when: boolean) => when && inputs.push({ type, key: type, silentIfPaid: true });
    once('profile_job_title', Boolean(p.jobTitle));
    once('profile_company', Boolean(p.company));
    once('profile_expertise', p.expertiseAreas.length > 0);
    once('profile_complete', completion(p).percent === 100);
    if (inputs.length === 0) return 0;
    return (await this.xp.award(p.id, inputs)).xpAwarded;
  }

  async getSettings(userId: string) {
    return toSettingsView(await this.load(userId));
  }

  async updateSettings(userId: string, body: z.infer<typeof settingsPatchBody>) {
    return toSettingsView(await this.save(userId, body));
  }

  async setContactSharing(userId: string, body: z.infer<typeof contactSharing>) {
    const p = await this.save(userId, { shareContactEnabled: body.enabled, shareEmail: body.email, sharePhone: body.phone });
    return toSettingsView(p).contactSharing;
  }

  async setAvatar(userId: string, data: Buffer) {
    const type = sniffImage(data);
    if (!type) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG, PNG or WebP image');

    const previous = (await this.load(userId)).avatarPath;
    const path = `${userId}/${randomUUID()}.${type.ext}`;
    const { url } = await this.avatars.upload(path, data, type.mime);
    try {
      await this.save(userId, { avatarUrl: url, avatarPath: path });
    } catch (err) {
      await this.avatars.remove([path]).catch(() => undefined);
      throw err;
    }
    if (previous) await this.avatars.remove([previous]).catch(() => undefined);
    return { avatarUrl: url };
  }

  async removeAvatar(userId: string) {
    const previous = (await this.load(userId)).avatarPath;
    await this.save(userId, { avatarUrl: null, avatarPath: null });
    if (previous) await this.avatars.remove([previous]).catch(() => undefined);
    return { avatarUrl: null };
  }
}
