import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';

export interface TestDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

/** In-process Postgres with a minimal stand-in for Supabase's `auth` schema, then our real migrations. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await client.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade
    );
  `);
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder });
  return { db, client, close: () => client.close() };
}

export async function insertAuthUser(db: Db, id: string, email: string): Promise<void> {
  await db.execute(sql`insert into auth.users (id, email) values (${id}, ${email})`);
}
