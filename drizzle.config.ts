// `db:generate` and `db:check` work offline. `db:migrate` needs DATABASE_URL,
// the same database the Hyperdrive config points at; without it drizzle-kit
// stops instead of guessing a database.
import {defineConfig} from 'drizzle-kit';

const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  ...(url ? {dbCredentials: {url}} : {}),
});
