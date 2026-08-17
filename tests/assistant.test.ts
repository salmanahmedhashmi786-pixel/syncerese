import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { ask, conversationMessages, type AskDeps } from '@/assistant/service'
import { CATALOGUE, catalogueFor } from '@/assistant/catalogue'
import { routeQuestion, unknownRuleTargets } from '@/assistant/route'
import type { ModelTurn } from '@/assistant/model'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { agingReport } from '@/finance/reports'
import { FULL_ACCESS } from '@/billing/access'

type Role = 'owner' | 'finance' | 'sales' | 'readonly'

const ctxFor = (f: OpsFixture, role: Role = 'owner'): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  licence: FULL_ACCESS,
})

/** A model that calls one tool, then says whatever the test wants. */
const stubModel = (tool: string, input: Record<string, unknown>, answer: string): AskDeps => {
  let called = false
  return {
    modelConfigured: () => true,
    askModel: async (): Promise<ModelTurn> => {
      if (!called) {
        called = true
        return { kind: 'tools', uses: [{ id: 't1', name: tool, input }] }
      }
      return { kind: 'text', text: answer }
    },
  }
}

const noModel: AskDeps = { modelConfigured: () => false }

/**
 * A context with an explicit permission set.
 *
 * Every BUILT-IN role includes the whole read-only bundle, so none of them
 * exercises the catalogue filter. Custom roles can and do grant less, which is
 * exactly the case the filter exists for — so the tests construct one rather
 * than asserting something untrue about `sales`.
 */
const withPermissions = (f: OpsFixture, permissions: string[]): RequestContext => ({
  ...ctxFor(f),
  permissions: new Set(permissions) as RequestContext['permissions'],
})

describe('the assistant', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  // -------------------------------------------------------------------------
  // Permissions. The assistant has no data path of its own.
  // -------------------------------------------------------------------------

  it('offers each role only the lookups it may read', () => {
    const owner = catalogueFor(ctxFor(f, 'owner')).map((e) => e.name)
    expect(owner).toEqual(CATALOGUE.map((e) => e.name))

    // A role granted invoice.read and nothing else sees only the invoice
    // lookups. The ledger one is never described to the model at all — a tool
    // that is not offered cannot be called, which is stronger than refusing it
    // after the fact.
    const invoicesOnly = catalogueFor(withPermissions(f, ['invoice.read'])).map((e) => e.name)
    expect(invoicesOnly).toContain('invoices.outstanding')
    expect(invoicesOnly).not.toContain('ledger.account_balances')
    expect(invoicesOnly).not.toContain('partners.find')
  })

  it('refuses a tool the asking user may not use, even if the model names it', async () => {
    const deps = stubModel('ledger.account_balances', {}, 'The balance is 0.')
    const result = await f.tx((tx) =>
      ask(tx, withPermissions(f, ['invoice.read']), 'what is in account 1200', undefined, deps),
    )
    // No retrieval happened, so nothing about the ledger reached the answer.
    expect(result.retrievals).toHaveLength(0)
  })

  it('rejects a question from a role that can read nothing at all', async () => {
    const noAccess: RequestContext = { ...ctxFor(f), permissions: new Set() }
    await expect(f.tx((tx) => ask(tx, noAccess, 'how much are we owed'))).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // The grounding guarantee, end to end.
  // -------------------------------------------------------------------------

  it('suppresses an answer that states a figure nobody retrieved', async () => {
    // The whole feature rests on this. A model CAN produce a wrong number; what
    // matters is that the user never sees it.
    const deps = stubModel(
      'invoices.outstanding',
      { direction: 'ar' },
      'Your customers owe you €47,300.00 in total.',
    )
    const result = await f.tx((tx) =>
      ask(tx, ctxFor(f), 'how much do customers owe us', undefined, deps),
    )

    expect(result.grounded).toBe(false)
    expect(result.answer).not.toContain('47,300')
    expect(result.answer).toMatch(/could not verify/i)
  })

  it('records the failure so drift is visible', async () => {
    const deps = stubModel('invoices.outstanding', {}, 'You are owed €47,300.00.')
    await f.tx((tx) => ask(tx, ctxFor(f), 'how much are we owed', undefined, deps))

    const rows = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select grounded, content from assistant_messages
         where organization_id = ${f.orgId} and role = 'assistant'
      `)
      return (res as unknown as { rows: { grounded: boolean; content: string }[] }).rows
    })
    expect(rows[0]!.grounded).toBe(false)
    // The rejected draft is NOT stored: its figures may be wrong ones.
    expect(rows[0]!.content).not.toContain('47,300')
  })

  it('lets a correctly-quoted answer through', async () => {
    const deps = stubModel('invoices.outstanding', { direction: 'ar' }, 'Nothing is overdue.')
    const result = await f.tx((tx) =>
      ask(tx, ctxFor(f), 'anything overdue?', undefined, deps),
    )
    expect(result.grounded).toBe(true)
    expect(result.answer).toBe('Nothing is overdue.')
  })

  // -------------------------------------------------------------------------
  // The audit trail.
  // -------------------------------------------------------------------------

  it('records which lookup ran and how many rows it returned', async () => {
    const deps = stubModel('invoices.outstanding', { direction: 'ar' }, 'Nothing outstanding.')
    await f.tx((tx) => ask(tx, ctxFor(f), 'what is outstanding', undefined, deps))

    const row = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select retrieved_query as "retrievedQuery", result_row_count as "rowCount"
          from assistant_messages
         where organization_id = ${f.orgId} and role = 'assistant'
      `)
      return (
        res as unknown as {
          rows: { retrievedQuery: { query: string; rows: number }[]; rowCount: number }[]
        }
      ).rows[0]!
    })

    expect(row.retrievedQuery[0]!.query).toBe('invoices.outstanding')
    expect(row.rowCount).toBe(row.retrievedQuery[0]!.rows)
  })

  it('rejects parameters the schema does not allow', async () => {
    // A model that supplies a value the column can never hold must not reach
    // the database. 'sale' is exactly that: plausible, and not what the
    // direction column holds.
    const deps = stubModel('invoices.outstanding', { direction: 'sale' }, 'Nothing outstanding.')
    const result = await f.tx((tx) =>
      ask(tx, ctxFor(f), 'what is outstanding', undefined, deps),
    )
    expect(result.retrievals).toHaveLength(0)
  })

  it('keeps the question and the answer in one conversation', async () => {
    const deps = stubModel('invoices.outstanding', {}, 'Nothing outstanding.')
    const first = await f.tx((tx) => ask(tx, ctxFor(f), 'what is outstanding', undefined, deps))

    const messages = await f.tx((tx) =>
      conversationMessages(tx, ctxFor(f), first.conversationId),
    )
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.content).toBe('what is outstanding')
  })

  it('will not open somebody else\'s conversation', async () => {
    const deps = stubModel('invoices.outstanding', {}, 'Nothing outstanding.')
    const mine = await f.tx((tx) => ask(tx, ctxFor(f), 'what is outstanding', undefined, deps))

    // Same tenant, different person. A thread can hold figures the asker's
    // permissions allowed and a colleague's do not.
    const someoneElse: RequestContext = {
      ...ctxFor(f),
      userId: '018f0000-0000-7000-8000-00000000beef',
    }
    await expect(
      f.tx((tx) => ask(tx, someoneElse, 'and now?', mine.conversationId, deps)),
    ).rejects.toThrow()
  })

  it('keeps one tenant out of another tenant\'s threads', async () => {
    const deps = stubModel('invoices.outstanding', {}, 'Nothing outstanding.')
    const mine = await f.tx((tx) => ask(tx, ctxFor(f), 'what is outstanding', undefined, deps))

    const other = await createOpsFixture()
    try {
      await expect(
        f.tx(() =>
          other.tx((tx) => ask(tx, ctxFor(other), 'and now?', mine.conversationId, deps)),
        ),
      ).rejects.toThrow()

      const theirs = await other.tx(async (tx) => {
        const res = await tx.execute(sql`select count(*)::int as n from assistant_messages`)
        return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
      })
      expect(theirs).toBe(0)
    } finally {
      await other.t.close()
    }
  })

  // -------------------------------------------------------------------------
  // No model configured — a supported way to run this.
  // -------------------------------------------------------------------------

  it('answers deterministically when no model is configured', async () => {
    const result = await f.tx((tx) =>
      ask(tx, ctxFor(f), 'how much are we owed?', undefined, noModel),
    )
    expect(result.deterministic).toBe(true)
    expect(result.grounded).toBe(true)
    expect(result.retrievals[0]!.query).toBe('receivables.summary')
  })

  it('says what it can answer when the question does not route', async () => {
    const result = await f.tx((tx) =>
      ask(tx, ctxFor(f), 'what is the weather like', undefined, noModel),
    )
    expect(result.retrievals).toHaveLength(0)
    expect(result.answer).toMatch(/fixed set of questions/i)
  })

  it('never routes to a lookup the user cannot read', () => {
    const restricted = catalogueFor(withPermissions(f, ['invoice.read']))
    // The ledger rule matches the words, finds no permitted entry, and falls
    // through — the fallback cannot reach further than the model path could.
    const routed = routeQuestion('what is the balance of account 1200', restricted)
    expect(routed?.entry.name).not.toBe('ledger.account_balances')

    // And with permission, the same question does route there.
    const full = catalogueFor(ctxFor(f, 'owner'))
    expect(routeQuestion('what is the balance of account 1200', full)?.entry.name).toBe(
      'ledger.account_balances',
    )
  })

  it('does not confuse "are we owed" with "we owe"', () => {
    // "how much are we owed" CONTAINS the substring "we owe". An unanchored
    // pattern read it as payables and answered with the amount owed to
    // SUPPLIERS — the exact opposite of the question, as a real number in the
    // right format. No error, nothing to notice.
    const all = catalogueFor(ctxFor(f, 'owner'))

    expect(routeQuestion('How much are we owed?', all)?.params.direction).toBe('ar')
    expect(routeQuestion('what is overdue?', all)?.params.direction).toBe('ar')
    expect(routeQuestion('who owes us money', all)?.params.direction).toBe('ar')

    // And the payable phrasings still reach 'ap'.
    expect(routeQuestion('how much do we owe suppliers', all)?.params.direction).toBe('ap')
    expect(routeQuestion('what supplier bills are overdue', all)?.params.direction).toBe('ap')
  })

  it('has no routing rule pointing at a lookup that does not exist', () => {
    // A typo here silently disables one branch of the fallback, and it is only
    // discovered when a customer on an isolated network reports that a question
    // stopped working.
    expect(unknownRuleTargets()).toEqual([])
  })

  // -------------------------------------------------------------------------
  // The catalogue itself.
  // -------------------------------------------------------------------------

  it('every lookup runs against a real schema', async () => {
    // Column names in hand-written SQL do not typecheck. This is what catches
    // the kind of drift that broke the GDPR export.
    for (const entry of CATALOGUE) {
      const params = entry.params.parse(defaultsFor(entry.name))
      const rows = await f.tx((tx) => entry.run(tx, ctxFor(f), params as never))
      expect(Array.isArray(rows), entry.name).toBe(true)
    }
  })

  it('agrees with the aging report about what is outstanding', async () => {
    // THE test for this catalogue. Running without error is not enough: a
    // filter comparing against a value the column can never hold returns zero
    // rows, and zero rows is a confident, well-formatted, completely wrong
    // answer sitting next to a dashboard that says otherwise. That happened —
    // the entries filtered on direction 'sale' where the schema uses 'ar'.
    await f.tx(async (tx) => {
      const inv = await createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [
          {
            description: 'Consulting',
            quantity: 2,
            unitPriceMinor: 50_000,
            taxRateId: f.vatRateId,
          },
        ],
      })
      await issueInvoice(tx, f.actor, inv.id)
    })

    const [summary, listed, aging] = await f.tx(async (tx) => [
      await entry('receivables.summary').run(tx, ctxFor(f), { direction: 'ar' } as never),
      await entry('invoices.outstanding').run(
        tx,
        ctxFor(f),
        { direction: 'ar', onlyOverdue: false, limit: 20 } as never,
      ),
      await agingReport(tx, f.orgId, { direction: 'ar', asOf: '2026-06-01' }),
    ])

    // Something was actually found — the assertion the previous version of
    // this test was missing.
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.length).toBe(aging.rows.length)
    expect(Number((summary[0] as Record<string, unknown>).invoiceCount)).toBe(aging.rows.length)

    const assistantTotal = listed.reduce(
      (n, r) => n + Number((r as Record<string, unknown>).outstandingMinor),
      0,
    )
    const reportTotal = aging.rows.reduce((n, r) => n + Number(r.outstandingMinor), 0)
    expect(assistantTotal).toBe(reportTotal)
  })

  it('declares every summable column as a numeric one', () => {
    // sumFields must be a subset of numericFields, or a column would be added
    // up without its values being admitted individually.
    for (const entry of CATALOGUE) {
      for (const field of entry.sumFields) {
        expect(entry.numericFields, entry.name).toContain(field)
      }
    }
  })
})

const entry = (name: string) => {
  const found = CATALOGUE.find((e) => e.name === name)
  if (!found) throw new Error(`No catalogue entry ${name}`)
  return found
}

/** Minimum parameters each entry needs to run at all. */
function defaultsFor(name: string): Record<string, unknown> {
  if (name === 'partners.find') return { name: 'a' }
  return {}
}
