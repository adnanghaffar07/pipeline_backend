import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/** Resolves to src/db/migrations under tsx, and to the copied migrations folder next to dist/db in the image. */
export const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('Migrations applied'))
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
