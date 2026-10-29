import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

/** Driver-agnostic handle: production uses postgres.js, tests use PGlite. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string): { db: Db; close(): Promise<void> } {
  // prepare:false keeps us compatible with Supabase's transaction-mode pooler as well as session mode.
  const client = postgres(url, { max: 10, prepare: false, idle_timeout: 30, connect_timeout: 10 });
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.end({ timeout: 5 }) };
}
