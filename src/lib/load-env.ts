import { config } from 'dotenv'

/**
 * Loads .env files for the command-line tools.
 *
 * `import 'dotenv/config'` reads `.env` and nothing else, while Next.js reads
 * `.env.local` first — so `npm run dev` saw one configuration and
 * `npm run db:migrate` saw another. That gap is invisible until a migration
 * runs against the wrong database.
 *
 * Order matters: dotenv does not overwrite a variable that is already set, so
 * the first file to define one wins, and a real environment variable beats
 * both. Same precedence Next.js uses.
 *
 * `.env.vercel` is read LAST, and only by the tools that import this file —
 * provisioning, migration, verification, drizzle-kit and the admin scripts.
 * The deployment runbook tells you to paste the Neon connection strings there
 * and then run `npm run db:provision`, which did not work: nothing loaded that
 * file, so the script reported `DATABASE_ADMIN_URL is not set` while the value
 * sat in the file the documentation named.
 *
 * Last, not first, because `.env.local` must keep winning for anyone doing
 * local work — otherwise a `.env.vercel` holding production credentials would
 * silently redirect every one of these tools at the live database.
 *
 * `next dev` and `npm run db:seed` do not import this at all, so neither can be
 * pointed at production by this file.
 *
 * Import this for its side effect, first, before anything reads process.env.
 */
config({ path: ['.env.local', '.env', '.env.vercel'] })
