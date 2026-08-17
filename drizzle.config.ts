import './src/lib/load-env'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Migrations run as the OWNER, never as the application role. The app role
    // must not be able to alter tables or drop RLS policies.
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
})
