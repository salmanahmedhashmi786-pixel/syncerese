import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  licenses,
  memberships,
  organizations,
  pipelineStages,
  pipelines,
  users,
} from '@/db/schema'
import type { AnyDb } from '@/db/tenant'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { hashPassword } from '@/auth/password'
import { provisionFinance, seedCurrencies } from '@/finance/setup'

/**
 * Self-service signup.
 *
 * Creates an organization, its owner, a trial licence and a working chart of
 * accounts in one transaction — so a new tenant can issue an invoice
 * immediately rather than staring at an empty system and wondering what to do.
 *
 * Until this existed the only organization in the database was the one the
 * development seed created, which meant a deployed instance had no way in.
 */

export const signupSchema = z.object({
  organizationName: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024),
  countryCode: z.string().length(2).optional(),
  baseCurrency: z.string().length(3).default('EUR'),
  locale: z.string().max(10).default('en-US'),
})

export type SignupInput = z.infer<typeof signupSchema>

/** Free trial: seats and duration a new tenant gets before paying. */
const TRIAL_SEATS = 5
const TRIAL_DAYS = 30

const SLUG_RE = /[^a-z0-9]+/g

/**
 * ASCII slug. "Vogel Handel GmbH" becomes "vogel-handel-gmbh".
 *
 * Deliberately strips accents rather than encoding them — the slug goes into
 * URLs and package-style identifiers, which is exactly the case the brief calls
 * out for using `Syncrese` rather than `Syncrèse`.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'workspace'
}

export type SignupResult = {
  organizationId: string
  userId: string
  slug: string
}

export async function signUp(db: AnyDb, input: unknown): Promise<SignupResult> {
  const parsed = signupSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Check the form and try again', parsed.error.issues)
  }
  const data = parsed.data
  const email = data.email.toLowerCase()

  // Users are global — the same person may already have an account with
  // another organization. Signing up again would need an invite, not a second
  // account, so this is refused rather than silently creating a duplicate.
  const existing = await withoutTenantScope(db, async (tx) => {
    const rows = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    return rows[0]
  })
  if (existing) {
    throw new AppError(
      'CONFLICT',
      'An account with that email already exists. Sign in instead, or ask an admin to invite you.',
    )
  }

  const organizationId = newId()
  const userId = newId()
  const passwordHash = await hashPassword(data.password)

  const slug = await uniqueSlug(db, slugify(data.organizationName))

  const ownerRoleId = await withoutTenantScope(db, async (tx) => {
    const rows = await tx.execute(
      sql`select id from roles where key = 'owner' and organization_id is null limit 1`,
    )
    const row = (rows as unknown as { rows: { id: string }[] }).rows[0]
    if (!row) {
      throw new AppError(
        'INTERNAL',
        'System roles are missing. Run the platform seed migration before accepting signups.',
      )
    }
    return row.id
  })

  // Everything in ONE transaction: the owner's user row, the organization, its
  // licence, the membership and a usable chart of accounts. A half-provisioned
  // tenant — an organization with no ledger, or a licence with no owner — is
  // worse than a failed signup.
  //
  // The user row is global rather than tenant-scoped, but it belongs in here
  // all the same: written separately it would survive a rollback, and the
  // duplicate-email check above would then refuse the retry forever. One
  // transient failure would cost that person their email address.
  //
  // app.org_id is set to the new id before the insert, which is what satisfies
  // the RLS WITH CHECK on `organizations` and the reason ids are generated in
  // the application rather than by the database.
  await withTenant(db, { organizationId, userId }, async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      name: data.name.trim(),
      passwordHash,
      status: 'active',
    })

    await tx.insert(organizations).values({
      id: organizationId,
      slug,
      name: data.organizationName.trim(),
      legalName: data.organizationName.trim(),
      baseCurrency: data.baseCurrency.toUpperCase(),
      locale: data.locale,
      countryCode: data.countryCode?.toUpperCase() ?? null,
      accent: 'syncrese',
      status: 'active',
    })

    await tx.insert(licenses).values({
      id: newId(),
      organizationId,
      plan: 'trial',
      seatCount: TRIAL_SEATS,
      status: 'trial',
      validUntil: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
    })

    // The seat trigger reads the licence, so the membership must come after it.
    await tx.insert(memberships).values({
      id: newId(),
      organizationId,
      userId,
      roleId: ownerRoleId,
      status: 'active',
    })

    await seedCurrencies(tx)
    await provisionFinance(tx, { organizationId, userId })

    // A default CRM pipeline, so Deals is usable on day one instead of
    // refusing every create with "no pipeline is configured".
    const pipelineId = newId()
    await tx.insert(pipelines).values({
      id: pipelineId,
      organizationId,
      name: 'Sales pipeline',
      isDefault: true,
    })
    await tx.insert(pipelineStages).values(
      [
        { name: 'Qualification', probabilityPct: 10 },
        { name: 'Proposal', probabilityPct: 35 },
        { name: 'Negotiation', probabilityPct: 65 },
        { name: 'Won', probabilityPct: 100, isWon: true },
        { name: 'Lost', probabilityPct: 0, isLost: true },
      ].map((s, i) => ({
        id: newId(),
        organizationId,
        pipelineId,
        name: s.name,
        position: i + 1,
        probabilityPct: s.probabilityPct,
        isWon: s.isWon ?? false,
        isLost: s.isLost ?? false,
      })),
    )

    await writeAudit(tx, {
      organizationId,
      actorUserId: userId,
      action: 'organization.created',
      entityType: 'organization',
      entityId: organizationId,
      after: {
        name: data.organizationName,
        slug,
        baseCurrency: data.baseCurrency,
        plan: 'trial',
        seats: TRIAL_SEATS,
      },
    })
  })

  return { organizationId, userId, slug }
}

/**
 * Finds a free slug.
 *
 * Two businesses can share a name, and the slug is unique per installation, so
 * a collision appends a counter rather than failing the signup.
 */
async function uniqueSlug(db: AnyDb, base: string): Promise<string> {
  return withoutTenantScope(db, async (tx) => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
      // Through the SECURITY DEFINER function, NOT a plain select. Signup is
      // pre-tenant, so app.org_id is unset and the `organizations` policy
      // filters a direct query to zero rows — which answered "free" every
      // time and turned the second collision into a unique-violation 500.
      const res = await tx.execute(
        sql`select public.organization_slug_taken(${candidate}) as taken`,
      )
      const taken = (res as unknown as { rows: { taken: boolean }[] }).rows[0]?.taken
      if (!taken) return candidate
    }
    return `${base}-${newId().slice(0, 8)}`
  })
}
