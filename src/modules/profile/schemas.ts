import { z } from 'zod';
import { isValidTimeZone } from '../xp/engine.js';

/** Empty strings and null both mean "clear this field". */
const clearable = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullable());

const shortText = (label: string) => clearable(z.string().trim().min(1).max(100, `${label} must be at most 100 characters`));

/** Accepts `linkedin.com/in/x` as well as full URLs; stores an https URL. */
const url = (label: string, hosts?: string[]) =>
  clearable(
    z
      .string()
      .trim()
      .max(2048)
      .transform((v, ctx) => {
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
        let parsed: URL;
        try {
          parsed = new URL(withScheme);
        } catch {
          ctx.addIssue({ code: 'custom', message: `Enter a valid ${label} URL` });
          return z.NEVER;
        }
        const host = parsed.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(parsed.protocol) || !host.includes('.')) {
          ctx.addIssue({ code: 'custom', message: `Enter a valid ${label} URL` });
          return z.NEVER;
        }
        if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
          ctx.addIssue({ code: 'custom', message: `Enter a ${label} URL (${hosts[0]})` });
          return z.NEVER;
        }
        return parsed.toString();
      }),
  );

const expertiseAreas = z
  .array(z.string().trim().min(1, 'Expertise areas cannot be empty').max(50, 'Each expertise area must be at most 50 characters'))
  .max(20, 'Add at most 20 expertise areas')
  .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, 'Expertise areas must be unique');

export const profilePatchBody = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required').max(100),
    // Email is the sign-in identity; changing it needs its own verified flow.
    email: z.never({ message: 'Email cannot be changed here yet' }),
    countryName: shortText('Country'),
    dialCode: z.string().trim().regex(/^\+\d{1,4}$/, 'Dial code must look like +92'),
    mobile: z.string().trim().min(4, 'Enter a valid mobile number').max(20),
    location: shortText('Location'),
    company: shortText('Company'),
    jobTitle: shortText('Job title'),
    linkedinUrl: url('LinkedIn', ['linkedin.com']),
    facebookUrl: url('Facebook', ['facebook.com', 'fb.com']),
    instagramUrl: url('Instagram', ['instagram.com']),
    websiteUrl: url('website'),
    expertiseAreas,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field to update');

export type ProfilePatch = z.infer<typeof profilePatchBody>;

export const profileResponse = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  countryName: z.string().nullable(),
  dialCode: z.string().nullable(),
  mobile: z.string().nullable(),
  location: z.string().nullable(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  facebookUrl: z.string().nullable(),
  instagramUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  expertiseAreas: z.array(z.string()),
  completion: z.object({
    percent: z.number().int(),
    missingFields: z.array(z.string()),
  }),
});

export const contactSharing = z.object({
  enabled: z.boolean(),
  email: z.boolean(),
  phone: z.boolean(),
});

export const settingsResponse = z.object({
  notificationsEnabled: z.boolean(),
  themePreference: z.enum(['light', 'dark', 'system']),
  /** IANA zone such as "Asia/Karachi"; null = UTC. Streak days and daily tasks follow it. */
  timezone: z.string().nullable(),
  showOnLeaderboard: z.boolean(),
  contactSharing,
});

export const settingsPatchBody = z
  .object({
    notificationsEnabled: z.boolean(),
    themePreference: z.enum(['light', 'dark', 'system']),
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine(isValidTimeZone, 'Unknown time zone (use an IANA name such as Asia/Karachi)')
      .nullable(),
    showOnLeaderboard: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Send at least one setting to update');

export const avatarResponse = z.object({ avatarUrl: z.string().nullable() });
