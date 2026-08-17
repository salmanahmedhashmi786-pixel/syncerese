import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { signUp, slugify } from '@/server/onboarding'
import { resolveContext, can } from '@/server/context'
import { withTenant } from '@/db/tenant'
import { createTestDb, seedUser, type TestDb } from './helpers/db'

/**
 * Self-service signup.
 *
 * This is the only way a deployed instance gets its first organization — the
 * development seed does not run in production — so every failure here is a
 * failure on the first screen a paying customer ever sees.
 */
describe('signup', () => {
  let t: TestDb

  beforeAll(async () => {
    t = await createTestDb()
  })

  afterAll(async () => {
    await t.close()
  })

  it('provisions a tenant that is usable immediately', async () => {
    const result = await signUp(t.db, {
      organizationName: 'Vogel Handel GmbH',
      name: 'Anke Vogel',
      email: 'Anke@Vogel.example',
      password: 'correct-horse-battery',
      countryCode: 'de',
      baseCurrency: 'eur',
    })

    expect(result.slug).toBe('vogel-handel-gmbh')

    // The owner can sign in and act. If this is null the tenant exists but
    // nobody can reach it.
    const ctx = await resolveContext(t.db, {
      userId: result.userId,
      organizationId: result.organizationId,
    })
    expect(ctx).not.toBeNull()
    expect(ctx!.role).toBe('owner')
    expect(can(ctx, 'invoice.create')).toBe(true)

    await withTenant(t.db, { organizationId: result.organizationId }, async (tx) => {
      const counts = await tx.execute(sql`
        select
          (select count(*) from accounts)        as accounts,
          (select count(*) from licenses)        as licenses,
          (select count(*) from memberships)     as memberships,
          (select count(*) from pipeline_stages) as stages,
          (select count(*) from currencies)      as currencies
      `)
      const row = (counts as unknown as { rows: Record<string, string>[] }).rows[0]!

      // A chart of accounts, or the tenant cannot post anything.
      expect(Number(row.accounts)).toBeGreaterThan(10)
      expect(Number(row.licenses)).toBe(1)
      expect(Number(row.memberships)).toBe(1)
      // A default pipeline, or Deals refuses every create.
      expect(Number(row.stages)).toBe(5)
      expect(Number(row.currencies)).toBeGreaterThan(0)
    })
  })

  it('normalises the email so a mixed-case signup can still sign in', async () => {
    // Sign-in lowercases before lookup, and the users table carries a
    // CHECK (email = lower(email)) — a stored "Anke@Vogel.example" would be a
    // locked-out account, not a cosmetic difference.
    const res = await t.client.query<{ email: string }>(
      `select email from users where email like '%vogel.example'`,
    )
    expect(res.rows[0]?.email).toBe('anke@vogel.example')
  })

  it('gives two businesses with the same name distinct slugs', async () => {
    // The original implementation asked `select exists(... from organizations)`
    // through withoutTenantScope. Signup is pre-tenant, so RLS filtered that to
    // zero rows and it answered "free" every time — the SECOND customer to sign
    // up with a colliding name got a unique-violation 500 rather than an
    // account. It only reproduces with the app role assumed, which is why this
    // runs through the real code path rather than a direct insert.
    const first = await signUp(t.db, {
      organizationName: 'Nordwind Logistik',
      name: 'Erik Sand',
      email: 'erik@nordwind-1.example',
      password: 'correct-horse-battery',
    })
    const second = await signUp(t.db, {
      organizationName: 'Nordwind Logistik',
      name: 'Mara Holm',
      email: 'mara@nordwind-2.example',
      password: 'correct-horse-battery',
    })

    expect(first.slug).toBe('nordwind-logistik')
    expect(second.slug).toBe('nordwind-logistik-2')
    expect(second.organizationId).not.toBe(first.organizationId)
  })

  it('refuses an email that already has an account', async () => {
    await seedUser(t, 'taken@example.test')

    await expect(
      signUp(t.db, {
        organizationName: 'Second Attempt Ltd',
        name: 'Someone Else',
        email: 'TAKEN@example.test',
        password: 'correct-horse-battery',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects a short password before touching the database', async () => {
    await expect(
      signUp(t.db, {
        organizationName: 'Weak Password Co',
        name: 'Test User',
        email: 'weak@example.test',
        password: 'short',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    const res = await t.client.query<{ n: string }>(
      `select count(*) as n from organizations where slug = 'weak-password-co'`,
    )
    expect(Number(res.rows[0]!.n)).toBe(0)
  })

  it('leaves nothing behind when provisioning fails half-way', async () => {
    // A tenant with an organization row but no chart of accounts, or a licence
    // with no owner, is worse than a failed signup: it is unreachable and
    // occupies its slug forever. The whole tenant-scoped side is one
    // transaction, so a failure must roll all of it back.
    await t.sudo(`
      create or replace function public.__fail_pipeline() returns trigger
        language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger __fail_pipeline before insert on public.pipelines
        for each row execute function public.__fail_pipeline();
    `)

    await expect(
      signUp(t.db, {
        organizationName: 'Halfway House AG',
        name: 'Rolls Back',
        email: 'rollback@example.test',
        password: 'correct-horse-battery',
      }),
    ).rejects.toThrow()

    await t.sudo(`drop trigger __fail_pipeline on public.pipelines`)

    const res = await t.client.query<{ orgs: string; users: string }>(`
      select
        (select count(*) from organizations where slug = 'halfway-house-ag') as orgs,
        (select count(*) from users where email = 'rollback@example.test')   as users
    `)
    expect(Number(res.rows[0]!.orgs)).toBe(0)
    // Including the user row. Left behind, it would make the duplicate-email
    // check refuse the retry — one transient failure and that person can never
    // sign up with their own address again.
    expect(Number(res.rows[0]!.users)).toBe(0)

    // And the retry succeeds.
    const retry = await signUp(t.db, {
      organizationName: 'Halfway House AG',
      name: 'Rolls Back',
      email: 'rollback@example.test',
      password: 'correct-horse-battery',
    })
    expect(retry.slug).toBe('halfway-house-ag')
  })
})

describe('signup throttle', () => {
  let t: TestDb

  beforeAll(async () => {
    t = await createTestDb()
  })

  afterAll(async () => {
    await t.close()
  })

  const consume = async (ipHash: string, limit = 3, window = '1 hour') => {
    const res = await t.client.query<{ allowed: boolean }>(
      `select public.consume_signup_attempt($1, $2, $3::interval) as allowed`,
      [ipHash, limit, window],
    )
    return res.rows[0]!.allowed
  }

  it('allows up to the limit and then refuses', async () => {
    expect(await consume('aaa')).toBe(true)
    expect(await consume('aaa')).toBe(true)
    expect(await consume('aaa')).toBe(true)
    expect(await consume('aaa')).toBe(false)
    expect(await consume('aaa')).toBe(false)
  })

  it('counts each address separately', async () => {
    // One abusive network must not lock out every other prospect — this is a
    // shared counter if the key is wrong, which turns the throttle into an
    // outage.
    expect(await consume('bbb')).toBe(true)
  })

  it('lets the window expire', async () => {
    expect(await consume('ccc', 1)).toBe(true)
    expect(await consume('ccc', 1)).toBe(false)

    // Age the window rather than sleeping through it.
    await t.sudo(`update signup_attempts set window_start = now() - interval '2 hours'`)

    expect(await consume('ccc', 1)).toBe(true)
  })

  it('is not readable or writable by the application role', async () => {
    // The throttle is worthless if the app can reset its own counter, and the
    // table should not be a queryable record of who visited the signup page.
    await expect(
      t.client.exec(`set role syncrese_app; select * from signup_attempts;`),
    ).rejects.toThrow(/permission denied/i)
    await t.sudo('reset role')

    await expect(
      t.client.exec(`set role syncrese_app; delete from signup_attempts;`),
    ).rejects.toThrow(/permission denied/i)
    await t.sudo('reset role')
  })
})

describe('slugify', () => {
  it('strips accents rather than encoding them', () => {
    expect(slugify('Syncrèse')).toBe('syncrese')
  })

  it('collapses punctuation and trims separators', () => {
    expect(slugify('  Müller & Söhne, S.à r.l.  ')).toBe('muller-sohne-s-a-r-l')
  })

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('workspace')
    expect(slugify('日本語')).toBe('workspace')
  })
})
