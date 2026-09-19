import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` uses this file. Migrations are applied with
// `pnpm db:migrate`; `drizzle-kit push` is never used.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './drizzle',
});
