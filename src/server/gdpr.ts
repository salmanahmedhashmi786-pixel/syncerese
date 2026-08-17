import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  consentRecords,
  erasureRequests,
  exportJobs,
  memberships,
  partnerContacts,
  users,
} from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError, notFound } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import type { RequestContext } from './context'
import { requirePermission } from './context'

/**
 * GDPR tooling (MUST DO #15).
 *
 * Two rights are implemented here: access/portability (Art. 15 and 20) and
 * erasure (Art. 17).
 *
 * ERASURE IS PSEUDONYMISATION, NOT DELETION. That was a deliberate decision,
 * and in an accounting system it is the only defensible one.
 *
 * Art. 17(3)(b) disapplies the right to erasure where processing is necessary
 * for compliance with a legal obligation. Every EU member state requires
 * invoices and ledger entries to be retained — six years in Ireland, eight in
 * Austria, ten in Germany — and a deleted invoice is a hole in a statutory
 * record, not a privacy improvement. Deleting one would also unbalance the
 * ledger, which is a different kind of wrong.
 *
 * So the identifiers are destroyed and the transaction survives. The person is
 * no longer identifiable from the operational data; the accounts still add up;
 * and the erasure report states exactly what was kept and on what basis, so
 * the controller can answer a data subject who asks.
 */

/**
 * The two kinds of natural person this system holds.
 *
 * `business_partner` is deliberately NOT one of them. A partner is a company;
 * where it is a sole trader the personal data is the contact record attached to
 * it, which is a `partner_contact`. Offering to erase the company would suggest
 * deleting a customer account is a privacy operation, which it is not.
 */
export const SUBJECT_TYPES = ['user', 'partner_contact'] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

export type DataSubject = {
  subjectType: SubjectType
  subjectId: string
  name: string | null
  email: string | null
  /** Already pseudonymised — the UI shows it rather than offering to do it
   *  again, and the erasure call is idempotent regardless. */
  erased: boolean
  description: string
}

// ---------------------------------------------------------------------------
// Finding a person
// ---------------------------------------------------------------------------

/**
 * Looks for a data subject by email, within this tenant only.
 *
 * A subject access request arrives as an email address, so that is the handle.
 * `users` is a global table, so it is deliberately narrowed to people with a
 * membership HERE: one tenant's admin must not be able to confirm whether an
 * address has an account with another.
 */
export async function findSubjects(
  tx: TenantTx,
  ctx: RequestContext,
  email: string,
): Promise<DataSubject[]> {
  requirePermission(ctx, 'gdpr.manage')

  const needle = email.trim().toLowerCase()
  if (needle.length < 3) {
    throw new AppError('VALIDATION_FAILED', 'Enter the email address to look up.')
  }

  const out: DataSubject[] = []

  const staff = await tx
    .select({ id: users.id, name: users.name, email: users.email, status: users.status })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(
      and(eq(memberships.organizationId, ctx.organizationId), eq(users.email, needle)),
    )
    .limit(1)

  for (const s of staff) {
    out.push({
      subjectType: 'user',
      subjectId: s.id,
      name: s.name,
      email: s.email,
      erased: s.email.endsWith('@erased.invalid'),
      description: 'A person with access to this workspace.',
    })
  }

  const contacts = await tx
    .select({
      id: partnerContacts.id,
      name: partnerContacts.name,
      email: partnerContacts.email,
    })
    .from(partnerContacts)
    .where(
      and(
        eq(partnerContacts.organizationId, ctx.organizationId),
        sql`lower(${partnerContacts.email}) = ${needle}`,
      ),
    )

  for (const c of contacts) {
    out.push({
      subjectType: 'partner_contact',
      subjectId: c.id,
      name: c.name,
      email: c.email,
      erased: c.email === null && c.name.startsWith('Erased'),
      description: 'A named contact at a customer or supplier.',
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Right of access (Art. 15) and portability (Art. 20)
// ---------------------------------------------------------------------------

export type SubjectExport = {
  generatedAt: string
  organizationId: string
  subject: { type: SubjectType; id: string }
  /** What is held, section by section. */
  data: Record<string, unknown>
  /** Personal data NOT included, and why. Art. 15(1) requires the data subject
   *  to be told what is processed, including what is retained under another
   *  lawful basis — an export that quietly omits it is not a complete answer. */
  retained: { category: string; basis: string }[]
}

export async function exportSubject(
  tx: TenantTx,
  ctx: RequestContext,
  input: { subjectType: string; subjectId: string },
): Promise<SubjectExport> {
  requirePermission(ctx, 'gdpr.manage')

  const subjectType = parseSubjectType(input.subjectType)
  const data: Record<string, unknown> = {}

  if (subjectType === 'user') {
    const row = (
      await tx
        .select()
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(
          and(eq(users.id, input.subjectId), eq(memberships.organizationId, ctx.organizationId)),
        )
        .limit(1)
    )[0]
    if (!row) throw notFound('That person is not a member of this organization.')

    data.account = {
      name: row.users.name,
      email: row.users.email,
      status: row.users.status,
      createdAt: row.users.createdAt,
      lastLoginAt: row.users.lastLoginAt,
      // Deliberately never exported: a password hash and an MFA secret are
      // credentials, not information about the person, and putting them in a
      // file the data subject receives by email would be a breach in itself.
      mfaEnabled: Boolean(row.users.mfaEnabledAt),
    }
    data.membership = {
      status: row.memberships.status,
      joinedAt: row.memberships.joinedAt,
      deactivatedAt: row.memberships.deactivatedAt,
    }

    data.workspacePreferences = await rowsFor(
      tx,
      sql`select column_visibility, dashboard_layout, updated_at
            from workspace_preferences
           where user_id = ${input.subjectId}
             and organization_id = ${ctx.organizationId}`,
    )

    data.chatMessages = await rowsFor(
      tx,
      sql`select m.body, m.created_at, c.name as channel
            from messages m
            join channels c on c.id = m.channel_id
           where m.organization_id = ${ctx.organizationId}
             and m.user_id = ${input.subjectId}
           order by m.created_at`,
    )

    data.activity = await rowsFor(
      tx,
      sql`select action, entity_type, entity_id, occurred_at
            from audit_log
           where organization_id = ${ctx.organizationId}
             and actor_user_id = ${input.subjectId}
           order by occurred_at desc
           limit 5000`,
    )
  } else {
    const contact = (
      await tx
        .select()
        .from(partnerContacts)
        .where(
          and(
            eq(partnerContacts.id, input.subjectId),
            eq(partnerContacts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1)
    )[0]
    if (!contact) throw notFound('No such contact in this organization.')

    data.contact = {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      role: contact.role,
      isPrimary: contact.isPrimary,
      marketingConsent: contact.marketingConsent,
      consentRecordedAt: contact.consentRecordedAt,
      consentSource: contact.consentSource,
      customFields: contact.customFields,
      createdAt: contact.createdAt,
    }

    data.organisation = await rowsFor(
      tx,
      sql`select name, legal_name, country_code from business_partners
           where id = ${contact.partnerId} and organization_id = ${ctx.organizationId}`,
    )
  }

  data.consentHistory = await rowsFor(
    tx,
    sql`select purpose, granted, source, recorded_at
          from consent_records
         where organization_id = ${ctx.organizationId}
           and subject_type = ${subjectType}
           and subject_id = ${input.subjectId}
         order by recorded_at`,
  )

  data.erasureRequests = await rowsFor(
    tx,
    sql`select requested_at, status, method, completed_at
          from erasure_requests
         where organization_id = ${ctx.organizationId}
           and subject_type = ${subjectType}
           and subject_id = ${input.subjectId}
         order by requested_at`,
  )

  // Logged as an access to personal data, which is itself a processing
  // activity a controller has to be able to account for.
  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'gdpr.subject_exported',
    entityType: subjectType,
    entityId: input.subjectId,
    requestId: ctx.requestId,
    ip: ctx.ip,
  })

  return {
    generatedAt: new Date().toISOString(),
    organizationId: ctx.organizationId,
    subject: { type: subjectType, id: input.subjectId },
    data,
    retained: RETAINED_CATEGORIES,
  }
}

/** What survives an erasure, and why. Stated in every export and every erasure
 *  report rather than left for someone to discover. */
const RETAINED_CATEGORIES = [
  {
    category: 'Invoices, credit notes and the ledger entries behind them',
    basis:
      'Art. 17(3)(b) — retention required by member-state accounting law (commonly 6–10 years). ' +
      'The counterparty details frozen on an issued invoice are part of the statutory record and ' +
      'cannot be altered without destroying its evidential value.',
  },
  {
    category: 'The audit trail of who changed what',
    basis:
      'Art. 17(3)(b) and legitimate interests — an audit log that can be edited on request is ' +
      'not an audit log. Entries reference an internal id, not a name, once the account is ' +
      'pseudonymised.',
  },
  {
    category: 'The erasure record itself',
    basis:
      'Art. 5(2) accountability — the controller must be able to demonstrate that the request ' +
      'was honoured, which requires keeping the fact that it happened.',
  },
]

// ---------------------------------------------------------------------------
// Right to erasure (Art. 17)
// ---------------------------------------------------------------------------

export const eraseSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().min(1),
  /** Recorded on the request. An erasure with no stated basis is not
   *  demonstrable compliance. */
  reason: z.string().min(3).max(500),
})

export type ErasureReport = {
  requestId: string
  method: 'pseudonymized'
  erased: string[]
  retained: { category: string; basis: string }[]
}

export async function eraseSubject(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<ErasureReport> {
  requirePermission(ctx, 'gdpr.manage')

  const parsed = eraseSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Give the subject and a reason for the erasure.')
  }
  const { subjectType, subjectId, reason } = parsed.data

  const erased: string[] = []
  const requestId = newId()

  if (subjectType === 'user') {
    // Membership check first: `users` is global, and without this an admin
    // could erase a person who has never been anywhere near this tenant.
    const member = (
      await tx
        .select({ userId: memberships.userId, status: memberships.status })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, subjectId),
            eq(memberships.organizationId, ctx.organizationId),
          ),
        )
        .limit(1)
    )[0]
    if (!member) throw notFound('That person is not a member of this organization.')

    if (member.userId === ctx.userId) {
      throw new AppError(
        'CONFLICT',
        'You cannot erase your own account from here — you would lose the access needed to ' +
          'finish the request. Ask another owner.',
      )
    }

    const before = (
      await tx.select().from(users).where(eq(users.id, subjectId)).limit(1)
    )[0]
    if (!before) throw notFound('No such person.')

    // A stable, non-routable address. It has to stay unique (the column is
    // unique) and lowercase (there is a CHECK), and it must not be deliverable
    // — `.invalid` is reserved by RFC 2606 precisely so it can never resolve.
    const tombstone = `erased-${subjectId}@erased.invalid`

    await tx
      .update(users)
      .set({
        email: tombstone,
        name: 'Erased user',
        passwordHash: null,
        avatarUrl: null,
        mfaSecretEncrypted: null,
        mfaEnabledAt: null,
        mfaRecoveryCodesHashed: null,
        status: 'deactivated',
        updatedAt: new Date(),
      })
      .where(eq(users.id, subjectId))

    // Their seat is freed as a side effect, which is correct — an erased person
    // is not using the workspace.
    await tx
      .update(memberships)
      .set({ status: 'deactivated', deactivatedAt: new Date(), deactivatedBy: ctx.userId })
      .where(
        and(
          eq(memberships.userId, subjectId),
          eq(memberships.organizationId, ctx.organizationId),
        ),
      )

    // Chat is conversational, not a statutory record, so the content goes.
    const messages = await tx.execute(sql`
      update messages
         set body = '[erased at the author’s request]', edited_at = now()
       where organization_id = ${ctx.organizationId}
         and user_id = ${subjectId}
      returning id
    `)
    const messageCount = (messages as unknown as { rows: unknown[] }).rows.length

    erased.push(
      'Name, email address and avatar replaced with a non-identifying placeholder',
      'Password and multi-factor credentials destroyed',
      'Workspace access revoked and the seat released',
      `Chat message content removed (${messageCount})`,
    )
  } else {
    const contact = (
      await tx
        .select()
        .from(partnerContacts)
        .where(
          and(
            eq(partnerContacts.id, subjectId),
            eq(partnerContacts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1)
    )[0]
    if (!contact) throw notFound('No such contact in this organization.')

    await tx
      .update(partnerContacts)
      .set({
        name: 'Erased contact',
        email: null,
        phone: null,
        role: null,
        // Custom fields are user-defined and routinely hold exactly the kind of
        // thing that has to go — a mobile number, a home address, a note.
        customFields: {},
        marketingConsent: false,
        consentRecordedAt: null,
        consentSource: null,
        archivedAt: contact.archivedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(partnerContacts.id, subjectId))

    erased.push(
      'Name, email address, phone number and job title removed',
      'Custom field values cleared',
      'Marketing consent withdrawn and the contact archived',
    )
  }

  // Withdrawing consent is part of erasure, and the withdrawal itself is
  // evidence the controller has to keep.
  await tx.insert(consentRecords).values({
    id: newId(),
    organizationId: ctx.organizationId,
    subjectType,
    subjectId,
    purpose: 'marketing',
    granted: false,
    source: 'erasure request',
    ip: ctx.ip ?? null,
  })

  const report: ErasureReport = {
    requestId,
    method: 'pseudonymized',
    erased,
    retained: RETAINED_CATEGORIES,
  }

  await tx.insert(erasureRequests).values({
    id: requestId,
    organizationId: ctx.organizationId,
    subjectType,
    subjectId,
    requestedBy: ctx.userId,
    status: 'completed',
    method: 'pseudonymized',
    completedAt: new Date(),
    report: { reason, ...report },
  })

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'gdpr.subject_erased',
    entityType: subjectType,
    entityId: subjectId,
    // The reason, not the data. Writing the erased values into the audit log
    // would put them back in the database the request was meant to clear.
    after: { method: 'pseudonymized', reason },
    requestId: ctx.requestId,
    ip: ctx.ip,
  })

  return report
}

// ---------------------------------------------------------------------------
// Portability for the whole tenant (Art. 20)
// ---------------------------------------------------------------------------

/**
 * Everything the organization owns, as structured JSON.
 *
 * Streamed to the caller and NOT written to a file with a URL, despite
 * `export_jobs.file_url` existing for that. A complete dump of a company's
 * customers, staff and ledger sitting on disk behind a guessable link is a
 * breach waiting for someone to find it; generating on demand means there is
 * nothing at rest to leak. The job row is still written, because "who exported
 * everything, and when" is exactly what an audit needs.
 */
export async function exportOrganization(
  tx: TenantTx,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'gdpr.manage')

  const jobId = newId()
  await tx.insert(exportJobs).values({
    id: jobId,
    organizationId: ctx.organizationId,
    requestedBy: ctx.userId,
    scope: 'organization',
    status: 'running',
  })

  const sections: Record<string, unknown> = {}
  for (const [name, statement] of EXPORT_SECTIONS(ctx.organizationId)) {
    sections[name] = await rowsFor(tx, statement)
  }

  await tx
    .update(exportJobs)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(exportJobs.id, jobId))

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'gdpr.organization_exported',
    entityType: 'organization',
    entityId: ctx.organizationId,
    requestId: ctx.requestId,
    ip: ctx.ip,
  })

  return {
    generatedAt: new Date().toISOString(),
    organizationId: ctx.organizationId,
    format: 'syncrese.export.v1',
    sections,
  }
}

/**
 * What a full export contains.
 *
 * Explicit rather than "every table with an organization_id": a generated dump
 * would sweep in `api_keys`, `license_keys` and the MFA columns, and an export
 * that hands the requester live credentials is a breach dressed as compliance.
 */
const EXPORT_SECTIONS = (orgId: string): [string, ReturnType<typeof sql>][] => [
  ['organization', sql`select name, legal_name, slug, country_code, base_currency, locale, created_at
                         from organizations where id = ${orgId}`],
  ['members', sql`select u.name, u.email, r.key as role, m.status, m.joined_at
                    from memberships m
                    join users u on u.id = m.user_id
                    join roles r on r.id = m.role_id
                   where m.organization_id = ${orgId}`],
  ['businessPartners', sql`select id, partner_no, name, legal_name, tax_id, country_code,
                                  is_customer, is_supplier, payment_terms_days, created_at
                             from business_partners where organization_id = ${orgId}`],
  ['contacts', sql`select id, partner_id, name, email, phone, role, marketing_consent, created_at
                     from partner_contacts where organization_id = ${orgId}`],
  ['chartOfAccounts', sql`select code, name, type, subtype, is_postable
                            from accounts where organization_id = ${orgId} order by code`],
  ['journalEntries', sql`select entry_no, entry_date, description, source_type, status
                           from journal_entries where organization_id = ${orgId} order by entry_no`],
  ['journalLines', sql`select je.entry_no, a.code as account_code, jl.debit_minor, jl.credit_minor,
                              jl.currency_code, jl.base_debit_minor, jl.base_credit_minor, jl.memo
                         from journal_lines jl
                         join journal_entries je on je.id = jl.journal_entry_id
                         join accounts a on a.id = jl.account_id
                        where jl.organization_id = ${orgId} order by je.entry_no`],
  ['invoices', sql`select invoice_no, direction, document_type_code, issue_date, due_date,
                          currency_code, subtotal_minor, tax_total_minor, total_minor,
                          amount_paid_minor, credited_minor, status, partner_snapshot
                     from invoices where organization_id = ${orgId} order by invoice_no`],
  ['invoiceLines', sql`select i.invoice_no, l.line_no, l.description, l.quantity,
                              l.unit_price_minor, l.net_minor, l.tax_amount_minor
                         from invoice_lines l
                         join invoices i on i.id = l.invoice_id
                        where l.organization_id = ${orgId} order by i.invoice_no, l.line_no`],
  ['payments', sql`select payment_no, direction, payment_date, currency_code, amount_minor,
                          method, reference, status
                     from payments where organization_id = ${orgId} order by payment_no`],
  ['products', sql`select sku, name, description, unit_code, sales_price_minor, currency_code
                     from products where organization_id = ${orgId} order by sku`],
  ['salesOrders', sql`select order_no, order_date, status, currency_code, total_minor
                        from sales_orders where organization_id = ${orgId} order by order_no`],
  ['purchaseOrders', sql`select po_no, order_date, status, currency_code, total_minor
                           from purchase_orders where organization_id = ${orgId} order by po_no`],
  ['deals', sql`select deal_no, name, status, amount_minor, currency_code, created_at
                  from deals where organization_id = ${orgId} order by deal_no`],
  ['consentRecords', sql`select subject_type, subject_id, purpose, granted, source, recorded_at
                           from consent_records where organization_id = ${orgId}`],
  ['erasureRequests', sql`select subject_type, subject_id, requested_at, status, method, completed_at
                            from erasure_requests where organization_id = ${orgId}`],
]

// ---------------------------------------------------------------------------

function parseSubjectType(value: string): SubjectType {
  if ((SUBJECT_TYPES as readonly string[]).includes(value)) return value as SubjectType
  throw new AppError('VALIDATION_FAILED', 'Unknown kind of data subject.')
}

async function rowsFor(tx: TenantTx, statement: ReturnType<typeof sql>): Promise<unknown[]> {
  const res = await tx.execute(statement)
  return (res as unknown as { rows: unknown[] }).rows
}
