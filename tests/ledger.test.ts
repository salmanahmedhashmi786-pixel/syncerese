import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { journalEntries, journalLines } from '@/db/schema'
import { newId } from '@/lib/ids'
import { fromDatabaseError } from '@/lib/errors'
import { postJournalEntry, reverseJournalEntry } from '@/finance/ledger'
import { createFinanceFixture, type FinanceFixture } from './helpers/finance'

/**
 * MUST DO #10: "write tests for the accounting/ledger logic ... these areas
 * must never have silent bugs."
 *
 * The database is the enforcement point, so several tests here bypass the
 * posting service entirely and write raw SQL — that is the only way to prove
 * the guarantee holds against code that has not read the posting engine.
 */
describe('double-entry ledger', () => {
  let f: FinanceFixture
  let bank: string
  let revenue: string
  let receivable: string

  beforeAll(async () => {
    f = await createFinanceFixture()
    bank = await f.accountId('bank')
    revenue = await f.accountId('revenue')
    receivable = await f.accountId('accounts_receivable')
  })

  afterAll(async () => {
    await f.t.close()
  })

  it('posts a balanced entry', async () => {
    const result = await f.tx((tx) =>
      postJournalEntry(tx, f.actor, {
        entryDate: '2026-03-15',
        description: 'Cash sale',
        lines: [
          { accountId: bank, debitMinor: 119_00 },
          { accountId: revenue, creditMinor: 119_00 },
        ],
      }),
    )

    expect(result.entryNo).toBeGreaterThan(0)

    const lines = await f.tx((tx) =>
      tx.select().from(journalLines).where(eq(journalLines.journalEntryId, result.id)),
    )
    expect(lines).toHaveLength(2)
    expect(lines.reduce((s, l) => s + l.baseDebitMinor, 0)).toBe(11900)
    expect(lines.reduce((s, l) => s + l.baseCreditMinor, 0)).toBe(11900)
  })

  it('refuses an unbalanced entry at the service layer with a clear message', async () => {
    await expect(
      f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-03-15',
          lines: [
            { accountId: bank, debitMinor: 100_00 },
            { accountId: revenue, creditMinor: 90_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/does not balance/)
  })

  it('refuses an unbalanced entry AT THE DATABASE, bypassing the service entirely', async () => {
    // This is the case that matters: a script, a data fix, a future feature
    // that never calls postJournalEntry.
    const entryId = newId()
    await expect(
      f.tx(async (tx) => {
        await tx.execute(sql`
          insert into journal_entries (id, organization_id, entry_no, entry_date, status)
          values (${entryId}, ${f.orgId}, 999001, '2026-03-15', 'draft')
        `)
        await tx.execute(sql`
          insert into journal_lines
            (id, organization_id, journal_entry_id, line_no, account_id,
             debit_minor, credit_minor, currency_code, base_debit_minor, base_credit_minor)
          values
            (${newId()}, ${f.orgId}, ${entryId}, 1, ${bank},   10000, 0, 'EUR', 10000, 0),
            (${newId()}, ${f.orgId}, ${entryId}, 2, ${revenue}, 0, 9000, 'EUR', 0, 9000)
        `)
      }),
    ).rejects.toThrow(/SYNC_UNBALANCED_ENTRY/)
  })

  it('refuses a single-sided entry even though it balances at zero', async () => {
    const entryId = newId()
    await expect(
      f.tx(async (tx) => {
        await tx.execute(sql`
          insert into journal_entries (id, organization_id, entry_no, entry_date, status)
          values (${entryId}, ${f.orgId}, 999002, '2026-03-15', 'draft')
        `)
        await tx.execute(sql`
          insert into journal_lines
            (id, organization_id, journal_entry_id, line_no, account_id,
             debit_minor, credit_minor, currency_code, base_debit_minor, base_credit_minor)
          values (${newId()}, ${f.orgId}, ${entryId}, 1, ${bank}, 0, 0, 'EUR', 0, 0)
        `)
      }),
    ).rejects.toThrow(/journal_lines_one_sided|SYNC_UNBALANCED_ENTRY/)
  })

  it('rejects a line that is both a debit and a credit', async () => {
    await expect(
      f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-03-15',
          lines: [
            { accountId: bank, debitMinor: 100, creditMinor: 100 },
            { accountId: revenue, creditMinor: 100 },
          ],
        }),
      ),
    ).rejects.toThrow(/either a debit or a credit/)
  })

  it('rejects a negative amount rather than silently flipping the side', async () => {
    await expect(
      f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-03-15',
          lines: [
            { accountId: bank, debitMinor: -100_00 },
            { accountId: revenue, creditMinor: -100_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/negative|either a debit or a credit/)
  })

  it('refuses to post to a header account', async () => {
    const headerId = await f.tx(async (tx) => {
      const rows = await tx.execute(
        sql`select id from accounts where organization_id = ${f.orgId} and code = '1000'`,
      )
      return (rows as unknown as { rows: { id: string }[] }).rows[0]!.id
    })

    await expect(
      f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-03-15',
          lines: [
            { accountId: headerId, debitMinor: 100_00 },
            { accountId: revenue, creditMinor: 100_00 },
          ],
        }),
      ),
    ).rejects.toThrow(/SYNC_ACCOUNT_NOT_POSTABLE/)
  })

  describe('immutability', () => {
    let postedId: string

    beforeAll(async () => {
      const r = await f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-04-01',
          description: 'To be protected',
          lines: [
            { accountId: receivable, debitMinor: 50_00 },
            { accountId: revenue, creditMinor: 50_00 },
          ],
        }),
      )
      postedId = r.id
    })

    it('cannot change a posted entry', async () => {
      await expect(
        f.tx((tx) =>
          tx
            .update(journalEntries)
            .set({ description: 'tampered' })
            .where(eq(journalEntries.id, postedId)),
        ),
      ).rejects.toThrow(/SYNC_POSTED_IMMUTABLE/)
    })

    it('cannot delete a posted entry', async () => {
      await expect(
        f.tx((tx) => tx.delete(journalEntries).where(eq(journalEntries.id, postedId))),
      ).rejects.toThrow(/SYNC_POSTED_IMMUTABLE/)
    })

    it('cannot edit the LINES of a posted entry either', async () => {
      // Rewriting history through the back door — the header looks untouched.
      await expect(
        f.tx((tx) =>
          tx
            .update(journalLines)
            .set({ debitMinor: 999_00 })
            .where(eq(journalLines.journalEntryId, postedId)),
        ),
      ).rejects.toThrow(/SYNC_POSTED_IMMUTABLE/)
    })

    it('cannot append a line to a posted entry', async () => {
      await expect(
        f.tx((tx) =>
          tx.insert(journalLines).values({
            id: newId(),
            organizationId: f.orgId,
            journalEntryId: postedId,
            lineNo: 99,
            accountId: bank,
            debitMinor: 1,
            creditMinor: 0,
            currencyCode: 'EUR',
            baseDebitMinor: 1,
            baseCreditMinor: 0,
          }),
        ),
      ).rejects.toThrow(/SYNC_POSTED_IMMUTABLE/)
    })

    it('surfaces a typed error, not a raw Postgres exception', async () => {
      try {
        await f.tx((tx) =>
          tx.delete(journalEntries).where(eq(journalEntries.id, postedId)),
        )
        expect.unreachable('should have been blocked')
      } catch (err) {
        const appErr = fromDatabaseError(err)
        expect(appErr?.code).toBe('IMMUTABLE_RECORD')
        expect(appErr?.message).toMatch(/reversing entry/)
      }
    })
  })

  describe('reversal', () => {
    it('mirrors the original and leaves both entries visible', async () => {
      const original = await f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-05-01',
          description: 'Mistaken posting',
          lines: [
            { accountId: receivable, debitMinor: 250_00 },
            { accountId: revenue, creditMinor: 250_00 },
          ],
        }),
      )

      const reversal = await f.tx((tx) => reverseJournalEntry(tx, f.actor, original.id))

      const [orig, rev] = await f.tx(async (tx) => [
        (await tx.select().from(journalEntries).where(eq(journalEntries.id, original.id)))[0]!,
        (await tx.select().from(journalEntries).where(eq(journalEntries.id, reversal.id)))[0]!,
      ])

      expect(orig.status).toBe('reversed')
      expect(orig.reversedByEntryId).toBe(reversal.id)
      expect(rev.reversesEntryId).toBe(original.id)

      const revLines = await f.tx((tx) =>
        tx.select().from(journalLines).where(eq(journalLines.journalEntryId, reversal.id)),
      )
      const arLine = revLines.find((l) => l.accountId === receivable)!
      // The debit became a credit.
      expect(arLine.creditMinor).toBe(25000)
      expect(arLine.debitMinor).toBe(0)

      // Net effect across both entries is zero.
      const net = await f.tx(async (tx) => {
        const res = await tx.execute(sql`
          select coalesce(sum(base_debit_minor - base_credit_minor), 0) as v
          from journal_lines
          where organization_id = ${f.orgId} and account_id = ${receivable}
            and journal_entry_id in (${original.id}, ${reversal.id})
        `)
        return Number((res as unknown as { rows: { v: string }[] }).rows[0]!.v)
      })
      expect(net).toBe(0)
    })

    it('refuses to reverse an already-reversed entry twice', async () => {
      const original = await f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-05-02',
          lines: [
            { accountId: receivable, debitMinor: 10_00 },
            { accountId: revenue, creditMinor: 10_00 },
          ],
        }),
      )
      await f.tx((tx) => reverseJournalEntry(tx, f.actor, original.id))
      await expect(f.tx((tx) => reverseJournalEntry(tx, f.actor, original.id))).rejects.toThrow(
        /Only a posted entry can be reversed/,
      )
    })
  })

  describe('period control', () => {
    it('refuses to post into a closed period', async () => {
      await f.t.sudo(`
        update fiscal_periods set status = 'closed'
        where organization_id = '${f.orgId}' and period_no = 1
      `)

      await expect(
        f.tx((tx) =>
          postJournalEntry(tx, f.actor, {
            entryDate: '2026-01-15',
            lines: [
              { accountId: bank, debitMinor: 100 },
              { accountId: revenue, creditMinor: 100 },
            ],
          }),
        ),
      ).rejects.toThrow(/SYNC_PERIOD_CLOSED/)
    })

    it('still allows posting into an open period', async () => {
      await expect(
        f.tx((tx) =>
          postJournalEntry(tx, f.actor, {
            entryDate: '2026-06-15',
            lines: [
              { accountId: bank, debitMinor: 100 },
              { accountId: revenue, creditMinor: 100 },
            ],
          }),
        ),
      ).resolves.toBeDefined()
    })
  })

  describe('multi-currency', () => {
    it('balances in base currency while the transaction currencies differ', async () => {
      // A EUR-based org receiving USD. Only base must balance — requiring each
      // transaction currency to balance would make this unpostable.
      const result = await f.tx((tx) =>
        postJournalEntry(tx, f.actor, {
          entryDate: '2026-06-20',
          description: 'USD receipt against EUR receivable',
          lines: [
            {
              accountId: bank,
              debitMinor: 110_00,
              currencyCode: 'USD',
              fxRate: 0.9,
              baseAmountMinor: 99_00,
            },
            { accountId: receivable, creditMinor: 99_00, currencyCode: 'EUR' },
          ],
        }),
      )

      const lines = await f.tx((tx) =>
        tx.select().from(journalLines).where(eq(journalLines.journalEntryId, result.id)),
      )
      const usd = lines.find((l) => l.currencyCode === 'USD')!
      expect(usd.debitMinor).toBe(11000) // transaction amount preserved
      expect(usd.baseDebitMinor).toBe(9900) // base amount recorded
      expect(lines.reduce((s, l) => s + l.baseDebitMinor, 0)).toBe(
        lines.reduce((s, l) => s + l.baseCreditMinor, 0),
      )
    })

    it('requires an exchange rate when the currency is not base', async () => {
      await expect(
        f.tx((tx) =>
          postJournalEntry(tx, f.actor, {
            entryDate: '2026-06-21',
            lines: [
              { accountId: bank, debitMinor: 100_00, currencyCode: 'USD' },
              { accountId: revenue, creditMinor: 100_00 },
            ],
          }),
        ),
      ).rejects.toThrow(/no exchange rate/)
    })
  })
})
