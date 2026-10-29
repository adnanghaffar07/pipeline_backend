import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { interestTopics, profiles, userInterests } from '../../src/db/schema.js';
import { createTestDb, insertAuthUser, type TestDb } from '../helpers/test-db.js';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('migrations', () => {
  it('applies migrations and seeds 17 topics in sort order', async () => {
    const rows = await t.db.select().from(interestTopics).orderBy(asc(interestTopics.sortOrder));
    expect(rows).toHaveLength(17);
    expect(rows[0]?.name).toBe('Network Transformation');
    expect(rows[16]?.name).toBe('Operational Agility');
    expect(new Set(rows.map((r) => r.slug)).size).toBe(17);
  });

  it('enables RLS on every public table', async () => {
    const res = await t.client.query<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`,
    );
    expect(res.rows).toEqual([]);
  });

  it('cascades profile and interests when auth user is deleted', async () => {
    const id = randomUUID();
    await insertAuthUser(t.db, id, 'cascade@example.com');
    await t.db.insert(profiles).values({ id, email: 'cascade@example.com', fullName: 'C', status: 'active' });
    await t.db.insert(userInterests).values({ userId: id, topicId: 1 });

    await t.db.execute(sql`delete from auth.users where id = ${id}`);

    expect(await t.db.select().from(profiles).where(eq(profiles.id, id))).toHaveLength(0);
    expect(await t.db.select().from(userInterests).where(eq(userInterests.userId, id))).toHaveLength(0);
  });

  it('rejects duplicate profile email', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await insertAuthUser(t.db, a, 'dup@example.com');
    await insertAuthUser(t.db, b, 'dup2@example.com');
    await t.db.insert(profiles).values({ id: a, email: 'dup@example.com', fullName: 'A', status: 'active' });
    await expect(
      t.db.insert(profiles).values({ id: b, email: 'dup@example.com', fullName: 'B', status: 'active' }),
    ).rejects.toThrow();
  });
});
