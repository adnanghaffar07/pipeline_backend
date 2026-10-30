import { SignJWT, importPKCS8 } from 'jose';
import type { Config } from '../config.js';

export interface PushMessage {
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  /** Flat string map delivered to the app (FCM requires string values). */
  data: Record<string, string>;
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Tokens FCM says are dead (app uninstalled, token rotated). The caller deletes them. */
  invalidTokens: string[];
}

export interface PushSender {
  readonly enabled: boolean;
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CONCURRENCY = 20;

/** Used when FIREBASE_SERVICE_ACCOUNT is not set: notifications still land in the feed, nothing is pushed. */
export class DisabledPush implements PushSender {
  readonly enabled = false;
  async send(tokens: string[]): Promise<PushResult> {
    return { sent: 0, failed: tokens.length, invalidTokens: [] };
  }
}

type Fetch = typeof fetch;

/**
 * FCM HTTP v1, signed with the service account via `jose` (no Firebase SDK, which is heavy for a serverless bundle).
 * One request per device token; fine for the current audience size. Very large broadcasts should move to FCM topics.
 */
export class FcmPush implements PushSender {
  readonly enabled = true;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: NonNullable<Config['firebase']>,
    private readonly http: Fetch = fetch,
    private readonly log: { warn: (o: object, m: string) => void } = console as never,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 60_000) return this.accessToken.value;
    const key = await importPKCS8(this.account.privateKey, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.account.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`FCM auth failed with HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    const result: PushResult = { sent: 0, failed: 0, invalidTokens: [] };
    if (tokens.length === 0) return result;
    let auth: string;
    try {
      auth = await this.token();
    } catch (err) {
      this.log.warn({ err }, 'push auth failed');
      return { sent: 0, failed: tokens.length, invalidTokens: [] };
    }
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`;
    const one = async (token: string) => {
      const res = await this.http(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, ...(message.body ? { body: message.body } : {}), ...(message.imageUrl ? { image: message.imageUrl } : {}) },
            data: message.data,
            android: { priority: 'high' },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
      }).catch(() => null);
      if (res?.ok) {
        result.sent++;
        return;
      }
      result.failed++;
      if (!res) return;
      const err = (await res.json().catch(() => null)) as { error?: { details?: Array<{ errorCode?: string }> } } | null;
      const code = err?.error?.details?.find((d) => d.errorCode)?.errorCode;
      // UNREGISTERED (404) = token no longer valid; INVALID_ARGUMENT on a token = malformed token.
      if (res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && code === 'INVALID_ARGUMENT')) {
        result.invalidTokens.push(token);
      } else {
        this.log.warn({ status: res.status, code }, 'push send failed');
      }
    };
    for (let i = 0; i < tokens.length; i += CONCURRENCY) {
      await Promise.all(tokens.slice(i, i + CONCURRENCY).map(one));
    }
    return result;
  }
}

export function createPush(config: Config, log?: { warn: (o: object, m: string) => void }): PushSender {
  return config.firebase ? new FcmPush(config.firebase, fetch, log) : new DisabledPush();
}
