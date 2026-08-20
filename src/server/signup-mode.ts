import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withoutTenantScope } from '@/db/tenant'

/**
 * Whether this installation accepts new organizations.
 *
 *  - `open`   — public SaaS. Anyone can create a tenant at /sign-up.
 *  - `closed` — self-hosted or invite-only. New members arrive by invitation
 *               from inside an existing organization.
 *
 * Defaults to closed, because that is the safe answer for a self-hosted install
 * that someone put on the public internet without reading the runbook. The
 * hosted deployment sets SIGNUP_MODE=open explicitly.
 *
 * Deliberately NOT in the 'use server' action module: every export of one of
 * those becomes a callable HTTP endpoint, and a flag the pages read at render
 * time has no business being one.
 */
export type SignupMode = 'open' | 'closed'

export function signupMode(): SignupMode {
  return process.env.SIGNUP_MODE === 'open' ? 'open' : 'closed'
}

/**
 * The same question, for a desktop install, where it has a better answer.
 *
 * A hosted deployment cannot know whether an open signup page is wanted, so it
 * asks the operator and defaults to no. A desktop install can just look: if
 * there are no organizations yet, this is first run and somebody has to be able
 * to create one. Once one exists, signup closes itself and never reopens.
 *
 * That removes the trap the hosted deployment walked straight into — a freshly
 * provisioned instance with signup closed, no account, and no way in except an
 * operator with shell access. Here there is no operator.
 *
 * It is not a weakening. A single-user install binds loopback and is
 * unreachable from anywhere else; a shared install is reachable only from the
 * office LAN, and only in the window before the first workspace is created.
 *
 * Falls back to `closed` if the database cannot be reached: an install whose
 * database is broken should not answer this question with "yes, anyone".
 */
export async function effectiveSignupMode(): Promise<SignupMode> {
  // Imported dynamically, and that is load-bearing rather than stylistic.
  //
  // This module is imported by the sign-in and sign-up PAGES, so a static
  // import here puts `@/desktop/mode` in the page's module graph. The build's
  // file tracer then evaluates `dataDir()` at build time, resolves it to a real
  // directory on the build machine, and globs it — walking into
  // `AppData\Local\Application Data`, a Windows compatibility junction that
  // points at its own parent and denies access by design. The build dies with
  // `EPERM: scandir` on a path nothing in this repository mentions.
  //
  // Every other consumer of that module already reaches it through
  // `await import()`, which the tracer does not follow eagerly. This one has to
  // as well.
  const { isDesktop } = await import('@/desktop/mode')
  if (!isDesktop()) return signupMode()

  try {
    const handle = await db()
    const count = await withoutTenantScope(handle, async (tx) => {
      const res = await tx.execute(sql`select count(*)::int as n from organizations`)
      return (res as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0
    })
    return count === 0 ? 'open' : 'closed'
  } catch {
    return 'closed'
  }
}
