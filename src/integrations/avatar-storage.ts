import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface AvatarStorage {
  /** Stores the image and returns its public URL. */
  upload(path: string, data: Buffer, contentType: string): Promise<{ url: string }>;
  /** Best effort: a missing object is not an error. */
  remove(paths: string[]): Promise<void>;
}

const BUCKET_LIMIT_BYTES = 5 * 1024 * 1024;

function unavailable(cause: unknown): AppError {
  return new AppError('STORAGE_UNAVAILABLE', 'Photo storage is temporarily unavailable', {}, { cause });
}

/** Public Supabase Storage bucket. Object names contain a random id, so URLs can't be guessed from a user id. */
export class SupabaseAvatarStorage implements AvatarStorage {
  private readonly client: SupabaseClient;
  private bucketReady = false;

  constructor(
    config: Config,
    private readonly bucket = config.avatarBucket,
    client?: SupabaseClient,
  ) {
    this.client =
      client ??
      createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
  }

  /** Creates the bucket on first use, so a new environment needs no manual dashboard step. */
  private async ensureBucket() {
    if (this.bucketReady) return;
    const { data } = await this.client.storage.getBucket(this.bucket);
    if (!data) {
      const { error } = await this.client.storage.createBucket(this.bucket, {
        public: true,
        fileSizeLimit: BUCKET_LIMIT_BYTES,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });
      if (error && !/already exists/i.test(error.message)) throw unavailable(error);
    }
    this.bucketReady = true;
  }

  async upload(path: string, data: Buffer, contentType: string) {
    await this.ensureBucket();
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, data, { contentType, upsert: false, cacheControl: '31536000' });
    if (error) throw unavailable(error);
    return { url: this.client.storage.from(this.bucket).getPublicUrl(path).data.publicUrl };
  }

  async remove(paths: string[]) {
    if (paths.length === 0) return;
    const { error } = await this.client.storage.from(this.bucket).remove(paths);
    if (error) throw unavailable(error);
  }
}
