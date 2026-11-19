// drizzle-kit reads this file only; the Worker bundles the generated migrations
// instead. Keeping the config here means `drizzle-kit generate` needs no
// database credentials (Durable Object migrations are plain SQL).
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  schema: './src/hub/schema.ts',
  out: './drizzle',
});
