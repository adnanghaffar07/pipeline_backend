import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

/** Driver-agnostic handle: production uses postgres.js, tests use PGlite. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbOptions {
  /** Max open connections for this process. Keep it small on serverless: every warm instance holds its own pool. */
  max: number;
}

export function createDb(url: string, opts: DbOptions = { max: 10 }): { db: Db; close(): Promise<void> } {
  // prepare:false keeps us compatible with Supabase's transaction-mode pooler as well as session mode.
  // Idle connections close after 20 s so a quiet instance gives its slots back to the pooler.
  const client = postgres(url, { max: opts.max, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.end({ timeout: 5 }) };
}

/**
 * Supabase's session pooler (port 5432 on *.pooler.supabase.com) caps clients at the pool size, so serverless
 * instances can exhaust it ("max clients reached"). The transaction pooler (port 6543) does not have that cap.
 */
export function isSupabaseSessionPooler(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.pooler.supabase.com') && (u.port === '' || u.port === '5432');
  } catch {
    return false;
  }
}
