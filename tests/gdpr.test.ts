import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { partnerContacts, users } from '@/db/schema'
import { type TenantTx } from '@/db/tenant'
import { resolveContext, type RequestContext } from '@/server/context'
import {
  eraseSubject,
  exportOrganization,
  exportSubject,
  findSubjects,
} from '@/server/gdpr'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { trialBalance } from '@/finance/reports'
import { newId } from '@/lib/ids'
import { createFinanceFixture, type FinanceFixture } from './helpers/finance'
import { roleId, seedUser } from './helpers/db'

/**
 * GDPR tooling.
 *
 * The two claims worth testing are that an export actually contains what is
 * held, and that an erasure actually destroys the identifiers WITHOUT damaging
 * the statutory records that law requires be kept. Getting the second half
 * wrong in either direction is serious: leave the name behind and the request
 * was not honoured; delete the invoice and the books no longer balance.
 */

describe('GDPR subject access and erasure', () => {
  let f: FinanceFixture
  let ctx: RequestContext
  let contactId: string
  let staffUserId: string

  const tx = <T>(fn: (t: TenantTx) => Promise<T>) => f.tx(fn)

  beforeAll(async () => {
    f = await createFinanceFixture()

    ctx = (await resolveContext(f.t.db, {
      userId: f.actor.userId!,
      organizationId: f.orgId,
    }))!

    // A named person at a customer.
    contactId = newId()
    await tx((t) =>
      t.insert(partnerContacts).values({
        id: contactId,
        organizationId: f.orgId,
        partnerId: f.customerId,
        name: 'Annika Vogel',
        email: 'annika@kunde.example',
        phone: '+49 40 123456',
        role: 'Head of Procurement',
        marketingConsent: true,
        consentRecordedAt: new Date(),
        consentSource: 'trade show',
        customFields: { mobile: '+49 170 999999' },
      }),
    )

    // A colleague with workspace access.
    staffUserId = await seedUser(f.t, 'kolleg@vogel.test')
    const sales = await roleId(f.t.client, 'sales')
    await f.t.sudo(
      `insert into memberships (id, organization_id, user_id, role_id, status)
       values (gen_random_uuid(), '${f.orgId}', '${staffUserId}', '${sales}', 'active');
       update users set name = 'Kolleg Muster' where id = '${staffUserId}'`,
    )
  })

  afterAll(async () => {
    await f.t.close()
  })

  // -------------------------------------------------------------------------
  // Finding people
  // -------------------------------------------------------------------------

  it('finds a contact by email', async () => {
    const found = await tx((t) => findSubjects(t, ctx, 'Annika@Kunde.example'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      subjectType: 'partner_contact',
      name: 'Annika Vogel',
      erased: false,
    })
  })

  it('finds a colleague by email', async () => {
    const found = await tx((t) => findSubjects(t, ctx, 'kolleg@vogel.test'))
    expect(found[0]?.subjectType).toBe('user')
  })

  it('finds nobody for an address this tenant does not hold', async () => {
    expect(await tx((t) => findSubjects(t, ctx, 'stranger@nowhere.example'))).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Right of access
  // -------------------------------------------------------------------------

  it('exports everything held about a contact', async () => {
    const out = await tx((t) =>
      exportSubject(t, ctx, { subjectType: 'partner_contact', subjectId: contactId }),
    )

    expect(out.data.contact).toMatchObject({
      name: 'Annika Vogel',
      email: 'annika@kunde.example',
      phone: '+49 40 123456',
      role: 'Head of Procurement',
      marketingConsent: true,
    })
    // Custom fields routinely hold exactly the kind of thing a subject access
    // request is about — a mobile number, a home address, a note.
    expect(out.data.contact).toMatchObject({ customFields: { mobile: '+49 170 999999' } })
    expect(out.data.organisation).toHaveLength(1)

    // Art. 15(1): the subject must be told what is processed, including what is
    // kept under another lawful basis. An export that quietly omits it is not a
    // complete answer.
    expect(out.retained.length).toBeGreaterThan(0)
    expect(JSON.stringify(out.retained)).toMatch(/17\(3\)\(b\)/)
  })

  it('exports a colleague without handing over their credentials', async () => {
    const out = await tx((t) =>
      exportSubject(t, ctx, { subjectType: 'user', subjectId: staffUserId }),
    )

    expect(out.data.account).toMatchObject({ name: 'Kolleg Muster', email: 'kolleg@vogel.test' })

    // A password hash and an MFA secret are credentials, not information about
    // the person. Putting them in a file the subject receives by email would be
    // a breach dressed as compliance.
    const serialised = JSON.stringify(out)
    expect(serialised).not.toMatch(/passwordHash|password_hash/)
    expect(serialised).not.toMatch(/mfaSecret|mfa_secret/)
  })

  it('records the access itself in the audit trail', async () => {
    const rows = await f.t.client.query<{ n: string }>(
      `select count(*) as n from audit_log
        where organization_id = $1 and action = 'gdpr.subject_exported'`,
      [f.orgId],
    )
    expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------

  it('erases a contact without touching the invoices they are behind', async () => {
    // An invoice to that contact's employer, issued and posted.
    const invoice = await tx((t) =>
      createInvoice(t, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Consulting', quantity: 2, unitPriceMinor: 50_000 }],
      }),
    )
    await tx((t) => issueInvoice(t, f.actor, invoice.id))

    const before = await tx((t) => trialBalance(t, f.orgId, { from: '2026-01-01', to: '2026-12-31' }))

    const report = await tx((t) =>
      eraseSubject(t, ctx, {
        subjectType: 'partner_contact',
        subjectId: contactId,
        reason: 'Article 17 request received by email on 2026-08-14',
      }),
    )

    expect(report.method).toBe('pseudonymized')

    const after = await tx(async (t) => {
      const rows = await t
        .select()
        .from(partnerContacts)
        .where(eq(partnerContacts.id, contactId))
        .limit(1)
      return rows[0]!
    })

    // Every identifier gone.
    expect(after.name).toBe('Erased contact')
    expect(after.email).toBeNull()
    expect(after.phone).toBeNull()
    expect(after.role).toBeNull()
    expect(after.customFields).toEqual({})
    expect(after.marketingConsent).toBe(false)
    expect(after.archivedAt).not.toBeNull()

    // And the books are untouched. Deleting the invoice would have been a hole
    // in a statutory record AND an unbalanced ledger.
    const balance = await tx((t) =>
      trialBalance(t, f.orgId, { from: '2026-01-01', to: '2026-12-31' }),
    )
    expect(balance.inBalance).toBe(true)
    expect(balance.totalDebitMinor).toBe(before.totalDebitMinor)

    const invoiceStillThere = await f.t.client.query<{ n: string }>(
      `select count(*) as n from invoices where id = $1`,
      [invoice.id],
    )
    expect(Number(invoiceStillThere.rows[0]!.n)).toBe(1)
  })

  it('leaves no trace of the erased contact in searchable data', async () => {
    const hits = await f.t.client.query<{ n: string }>(
      `select count(*) as n from partner_contacts
        where organization_id = $1
          and (name ilike '%Annika%' or email ilike '%annika%' or phone like '%123456%'
               or custom_fields::text ilike '%999999%')`,
      [f.orgId],
    )
    expect(Number(hits.rows[0]!.n)).toBe(0)
  })

  it('does not write the erased values into the audit log', async () => {
    // The audit entry records that an erasure happened and why. Writing the
    // erased values into it would put them straight back into the database the
    // request was meant to clear.
    const rows = await f.t.client.query<{ n: string }>(
      `select count(*) as n from audit_log
        where organization_id = $1
          and action = 'gdpr.subject_erased'
          and (after::text ilike '%Annika%' or after::text ilike '%kunde.example%')`,
      [f.orgId],
    )
    expect(Number(rows.rows[0]!.n)).toBe(0)
  })

  it('records the erasure so compliance can be demonstrated', async () => {
    // Art. 5(2) accountability — the controller has to be able to show the
    // request was honoured, which means keeping the fact that it happened.
    const rows = await f.t.client.query<{ status: string; method: string; report: { reason: string } }>(
      `select status, method, report from erasure_requests
        where organization_id = $1 and subject_id = $2`,
      [f.orgId, contactId],
    )
    expect(rows.rows[0]).toMatchObject({ status: 'completed', method: 'pseudonymized' })
    expect(rows.rows[0]!.report.reason).toMatch(/Article 17/)
  })

  it('is idempotent', async () => {
    // A request repeated because the first response was missed must not fail.
    await expect(
      tx((t) =>
        eraseSubject(t, ctx, {
          subjectType: 'partner_contact',
          subjectId: contactId,
          reason: 'Repeat of the same request',
        }),
      ),
    ).resolves.toMatchObject({ method: 'pseudonymized' })
  })

  it('erases a colleague, frees their seat and destroys their credentials', async () => {
    await tx((t) =>
      eraseSubject(t, ctx, {
        subjectType: 'user',
        subjectId: staffUserId,
        reason: 'Left the company and asked to be erased',
      }),
    )

    const after = await f.t.client.query<{
      email: string
      name: string
      password_hash: string | null
      mfa_secret_encrypted: string | null
      status: string
    }>(`select email, name, password_hash, mfa_secret_encrypted, status from users where id = $1`, [
      staffUserId,
    ])
    const row = after.rows[0]!

    expect(row.name).toBe('Erased user')
    expect(row.password_hash).toBeNull()
    expect(row.mfa_secret_encrypted).toBeNull()
    expect(row.status).toBe('deactivated')
    // Non-routable by construction — `.invalid` is reserved by RFC 2606 so it
    // can never resolve — while still unique and lowercase, which the column
    // requires.
    expect(row.email).toMatch(/@erased\.invalid$/)
    expect(row.email).toBe(row.email.toLowerCase())

    const seat = await f.t.client.query<{ status: string }>(
      `select status from memberships where user_id = $1 and organization_id = $2`,
      [staffUserId, f.orgId],
    )
    expect(seat.rows[0]!.status).toBe('deactivated')

    // And they can no longer reach the workspace.
    expect(
      await resolveContext(f.t.db, { userId: staffUserId, organizationId: f.orgId }),
    ).toBeNull()
  })

  it('refuses to erase the person running the request', async () => {
    // They would lose the access needed to finish it, and the report would be
    // written by an account that no longer exists.
    await expect(
      tx((t) =>
        eraseSubject(t, ctx, {
          subjectType: 'user',
          subjectId: ctx.userId,
          reason: 'Trying to erase myself',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses an erasure with no stated reason', async () => {
    await expect(
      tx((t) =>
        eraseSubject(t, ctx, { subjectType: 'partner_contact', subjectId: contactId, reason: '' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  // -------------------------------------------------------------------------
  // Portability
  // -------------------------------------------------------------------------

  it('exports the whole organization', async () => {
    // This runs every hand-written statement in the export, which is the only
    // way a mistyped column name gets caught before a customer asks for their
    // data and receives a 500.
    const out = await tx((t) => exportOrganization(t, ctx))
    const sections = out.sections as Record<string, unknown[]>

    expect(out.format).toBe('syncrese.export.v1')
    expect(sections.organization).toHaveLength(1)
    expect(sections.businessPartners!.length).toBeGreaterThan(0)
    expect(sections.chartOfAccounts!.length).toBeGreaterThan(10)
    expect(sections.invoices!.length).toBeGreaterThan(0)
    expect(sections.journalLines!.length).toBeGreaterThan(0)

    // Every declared section resolved rather than silently missing.
    for (const [name, rows] of Object.entries(sections)) {
      expect(Array.isArray(rows), `${name} did not return rows`).toBe(true)
    }
  })

  it('never puts credentials in the organization export', async () => {
    const out = await tx((t) => exportOrganization(t, ctx))
    const serialised = JSON.stringify(out)

    // An export generated from "every table with an organization_id" would
    // sweep in API keys, licence keys and MFA secrets — handing the requester
    // live credentials.
    expect(serialised).not.toMatch(/password_hash|key_hash|token_hash|mfa_secret|secret_hash/)
  })

  it('records who exported everything and when', async () => {
    const rows = await f.t.client.query<{ status: string; scope: string }>(
      `select status, scope from export_jobs where organization_id = $1 order by created_at desc limit 1`,
      [f.orgId],
    )
    expect(rows.rows[0]).toMatchObject({ status: 'completed', scope: 'organization' })
  })
})

// ---------------------------------------------------------------------------

describe('GDPR tooling respects tenant boundaries', () => {
  let a: FinanceFixture
  let ctxA: RequestContext
  let otherContactId: string

  beforeAll(async () => {
    a = await createFinanceFixture()
    ctxA = (await resolveContext(a.t.db, {
      userId: a.actor.userId!,
      organizationId: a.orgId,
    }))!

    // A second tenant in the same database, with its own contact.
    const orgB = newId()
    await a.t.sudo(`
      insert into organizations (id, slug, name, base_currency)
      values ('${orgB}', 'other-gdpr', 'Other GmbH', 'EUR');
      insert into licenses (id, organization_id, plan, seat_count, status)
      values (gen_random_uuid(), '${orgB}', 'starter', 5, 'active');
      insert into business_partners (id, organization_id, partner_no, name, is_customer)
      values ('${orgB}', '${orgB}', 'BP-90001', 'Their Customer', true);
    `)
    otherContactId = newId()
    await a.t.sudo(
      `insert into partner_contacts (id, organization_id, partner_id, name, email)
       values ('${otherContactId}', '${orgB}', '${orgB}', 'Their Person', 'their@person.example')`,
    )
  })

  afterAll(async () => {
    await a.t.close()
  })

  it('cannot find another tenant’s contact', async () => {
    expect(await a.tx((t) => findSubjects(t, ctxA, 'their@person.example'))).toEqual([])
  })

  it('cannot export another tenant’s contact', async () => {
    await expect(
      a.tx((t) =>
        exportSubject(t, ctxA, { subjectType: 'partner_contact', subjectId: otherContactId }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('cannot erase another tenant’s contact', async () => {
    await expect(
      a.tx((t) =>
        eraseSubject(t, ctxA, {
          subjectType: 'partner_contact',
          subjectId: otherContactId,
          reason: 'Should be refused',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // And it really is untouched.
    const row = await a.t.client.query<{ name: string; email: string }>(
      `select name, email from partner_contacts where id = $1`,
      [otherContactId],
    )
    expect(row.rows[0]).toMatchObject({ name: 'Their Person', email: 'their@person.example' })
  })

  it('cannot erase a user who has never been in this organization', async () => {
    // `users` is a global table. Without a membership check an admin could
    // erase somebody who has never been anywhere near their tenant.
    const outsider = await seedUser(a.t, 'outsider@elsewhere.example')
    await expect(
      a.tx((t) =>
        eraseSubject(t, ctxA, {
          subjectType: 'user',
          subjectId: outsider,
          reason: 'Should be refused',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const row = await a.t.client.query<{ email: string }>(`select email from users where id = $1`, [
      outsider,
    ])
    expect(row.rows[0]!.email).toBe('outsider@elsewhere.example')
  })

  it('scopes the organization export to this tenant', async () => {
    const out = await a.tx((t) => exportOrganization(t, ctxA))
    const sections = out.sections as Record<string, { name?: string }[]>
    expect(sections.organization).toHaveLength(1)
    expect(JSON.stringify(sections)).not.toMatch(/Their Person|Other GmbH/)
  })
})

// Keeps the unused-import checker honest about `users` and `sql`, which the
// raw-SQL assertions above reach through the client rather than the ORM.
void users
void sql
