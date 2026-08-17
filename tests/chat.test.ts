import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { newId } from '@/lib/ids'
import { memberships } from '@/db/schema'
import { withTenant } from '@/db/tenant'
import {
  createChannel,
  deleteMessage,
  dmKeyFor,
  editMessage,
  extractMentions,
  extractReferences,
  joinChannel,
  listChannels,
  listMessages,
  markChannelRead,
  openDirectMessage,
  postMessage,
  unreadNotifications,
} from '@/chat/service'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { roleId, seedUser } from './helpers/db'
import { FULL_ACCESS } from '@/billing/access'

const ctxFor = (f: OpsFixture, userId: string): RequestContext => ({
  userId,
  organizationId: f.orgId,
  membershipId: 'test',
  role: 'admin',
  permissions: grantsFor('admin'),
  requestId: null,
  ip: null,
  userAgent: null,
  // These fixtures build a context by hand rather than through resolveContext.
  // A licensed, in-date tenant is the right default: nothing here is testing
  // billing, and an unlicensed default would make every unrelated write fail.
  licence: FULL_ACCESS,
})

/** Adds a second real member so DMs and mentions have someone to reach. */
async function addColleague(f: OpsFixture, email: string, name: string): Promise<string> {
  const userId = await seedUser(f.t, email)
  await f.t.sudo(`update users set name = '${name}' where id = '${userId}'`)
  const role = await roleId(f.t.client, 'sales')
  await withTenant(f.t.db, { organizationId: f.orgId }, (tx) =>
    tx.insert(memberships).values({
      id: newId(),
      organizationId: f.orgId,
      userId,
      roleId: role,
      status: 'active',
    }),
  )
  return userId
}

describe('mention and reference parsing', () => {
  it('extracts mentions', () => {
    expect(extractMentions('hey @sarah and @tom.smith, look')).toEqual(['sarah', 'tom.smith'])
  })

  it('de-duplicates and lowercases', () => {
    expect(extractMentions('@Sarah @sarah @SARAH')).toEqual(['sarah'])
  })

  it('ignores an email address', () => {
    // "mail me at x@example.com" must not mention a user called "example".
    expect(extractMentions('mail me at bob@example.com')).toEqual([])
  })

  it('extracts document references and maps them to modules', () => {
    expect(extractReferences('check INV-00042 against PO-00007')).toEqual([
      { label: 'INV-00042', module: 'invoices' },
      { label: 'PO-00007', module: 'purchase-orders' },
    ])
  })

  it('is case-insensitive and de-duplicates references', () => {
    expect(extractReferences('inv-00042 and INV-00042')).toEqual([
      { label: 'INV-00042', module: 'invoices' },
    ])
  })

  it('ignores things that merely look like references', () => {
    expect(extractReferences('INV-1 and XX-00042 and INVOICE-00042')).toEqual([])
  })
})

describe('team chat', () => {
  let f: OpsFixture
  let owner: string
  let sarah: string

  beforeEach(async () => {
    f = await createOpsFixture()
    owner = f.actor.userId!
    sarah = await addColleague(f, 'sarah@vogel.test', 'Sarah Klein')
  })

  afterEach(async () => {
    await f.t.close()
  })

  describe('channels', () => {
    it('creates a channel with the creator as an admin member', async () => {
      const ch = await f.tx((tx) =>
        createChannel(tx, ctxFor(f, owner), { name: 'finance', topic: 'Month end' }),
      )
      const list = await f.tx((tx) => listChannels(tx, ctxFor(f, owner)))
      expect(list).toHaveLength(1)
      expect(list[0]!.name).toBe('finance')
      expect(list[0]!.memberCount).toBe(1)
      void ch
    })

    it('rejects channel names containing # or @', async () => {
      await expect(
        f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: '#finance' })),
      ).rejects.toThrow(/Invalid channel/)
    })

    it('a non-member does not see a channel in their list', async () => {
      await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'private-talk' }))
      const sarahsList = await f.tx((tx) => listChannels(tx, ctxFor(f, sarah)))
      expect(sarahsList).toHaveLength(0)
    })

    it('lets anyone join a public channel but not a private one', async () => {
      const open = await f.tx((tx) =>
        createChannel(tx, ctxFor(f, owner), { name: 'general', isPrivate: false }),
      )
      const closed = await f.tx((tx) =>
        createChannel(tx, ctxFor(f, owner), { name: 'leadership', isPrivate: true }),
      )

      await expect(f.tx((tx) => joinChannel(tx, ctxFor(f, sarah), open.id))).resolves.not.toThrow()
      await expect(f.tx((tx) => joinChannel(tx, ctxFor(f, sarah), closed.id))).rejects.toThrow(
        /private/,
      )
    })
  })

  describe('direct messages', () => {
    it('resolves A→B and B→A to the SAME conversation', async () => {
      const first = await f.tx((tx) => openDirectMessage(tx, ctxFor(f, owner), sarah))
      const second = await f.tx((tx) => openDirectMessage(tx, ctxFor(f, sarah), owner))

      // Without a canonical key each direction creates its own channel and half
      // the history disappears from each side.
      expect(second.id).toBe(first.id)
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
    })

    it('builds the same key regardless of argument order', () => {
      expect(dmKeyFor('b', 'a')).toBe(dmKeyFor('a', 'b'))
    })

    it('refuses a DM with yourself', async () => {
      await expect(
        f.tx((tx) => openDirectMessage(tx, ctxFor(f, owner), owner)),
      ).rejects.toThrow(/with yourself/)
    })

    it('refuses a DM with someone outside the organization', async () => {
      const outsider = await seedUser(f.t, 'outsider@elsewhere.test')
      await expect(
        f.tx((tx) => openDirectMessage(tx, ctxFor(f, owner), outsider)),
      ).rejects.toThrow(/not a member of this organization/)
    })
  })

  describe('posting', () => {
    it('posts and reads back in order', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'first' }))
      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'second' }))

      const msgs = await f.tx((tx) => listMessages(tx, ctxFor(f, owner), ch.id))
      expect(msgs.map((m) => m.body)).toEqual(['first', 'second'])
      expect(msgs[0]!.authorName).toBeTruthy()
    })

    it('orders messages posted in the SAME transaction correctly', async () => {
      // Postgres now() is TRANSACTION-start time, so every message written in
      // one transaction carries an identical created_at. Ordering by timestamp
      // alone is then arbitrary and a conversation displays scrambled — which
      // is exactly what the seeded demo did.
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))

      await f.tx(async (tx) => {
        for (const body of ['one', 'two', 'three', 'four', 'five']) {
          await postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body })
        }
      })

      const msgs = await f.tx((tx) => listMessages(tx, ctxFor(f, owner), ch.id))
      expect(msgs.map((m) => m.body)).toEqual(['one', 'two', 'three', 'four', 'five'])

      // And they really do share a timestamp — otherwise this test would pass
      // for the wrong reason.
      const distinct = await f.tx(async (tx) => {
        const res = await tx.execute(sql`
          select count(distinct created_at)::int as n from messages
           where channel_id = ${ch.id}
        `)
        return Number((res as unknown as { rows: { n: number }[] }).rows[0]!.n)
      })
      expect(distinct).toBe(1)
    })

    it('REFUSES a post from a non-member, at the database', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))

      await expect(
        f.tx((tx) => postMessage(tx, ctxFor(f, sarah), { channelId: ch.id, body: 'sneaking in' })),
      ).rejects.toThrow(/not a member/)

      // And bypassing the service entirely still fails — tenant isolation says
      // nothing about posting into a channel you were never added to.
      await expect(
        f.tx((tx) =>
          tx.execute(sql`
            insert into messages (id, organization_id, channel_id, user_id, body)
            values (${newId()}, ${f.orgId}, ${ch.id}, ${sarah}, 'raw sql')
          `),
        ),
      ).rejects.toThrow(/SYNC_NOT_A_MEMBER/)
    })

    it('records mentions and notifies the mentioned person', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), {
          channelId: ch.id,
          body: 'hey @sarah can you look at this?',
        }),
      )

      expect(posted.mentions).toHaveLength(1)
      expect(posted.mentions[0]!.userId).toBe(sarah)

      const notes = await f.tx((tx) => unreadNotifications(tx, ctxFor(f, sarah)))
      expect(notes).toHaveLength(1)
      expect(notes[0]!.type).toBe('mention')
      expect(notes[0]!.href).toContain(ch.id)
    })

    it('does not notify you for mentioning yourself', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'note to @owner self' }),
      )
      expect(posted.mentions).toHaveLength(0)
      expect(await f.tx((tx) => unreadNotifications(tx, ctxFor(f, owner)))).toHaveLength(0)
    })

    it('does not resolve a mention of someone outside the organization', async () => {
      await seedUser(f.t, 'ghost@elsewhere.test')
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'hi @ghost' }),
      )
      expect(posted.mentions).toHaveLength(0)
    })

    it('links a real document reference and ignores an unreal one', async () => {
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-03-01',
          lines: [{ description: 'Widget', unitPriceMinor: 100_00 }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), {
          channelId: ch.id,
          body: `please chase ${inv.invoiceNo}, and INV-99999 does not exist`,
        }),
      )

      // Only the reference that resolves becomes a link — a dead link is worse
      // than plain text.
      expect(posted.references).toHaveLength(1)
      expect(posted.references[0]).toMatchObject({
        module: 'invoices',
        entityId: inv.id,
        label: inv.invoiceNo,
      })

      const msgs = await f.tx((tx) => listMessages(tx, ctxFor(f, owner), ch.id))
      expect(msgs[0]!.refs).toHaveLength(1)
      expect(msgs[0]!.refs[0]!.label).toBe(inv.invoiceNo)
    })

    it('rejects an empty or oversized message', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      await expect(
        f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: '' })),
      ).rejects.toThrow(/Invalid message/)
      await expect(
        f.tx((tx) =>
          postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'x'.repeat(4001) }),
        ),
      ).rejects.toThrow(/Invalid message/)
    })
  })

  describe('editing and deleting', () => {
    it('only the author may edit, and the edit is marked', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      await f.tx((tx) => joinChannel(tx, ctxFor(f, sarah), ch.id))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'original' }),
      )

      await expect(
        f.tx((tx) => editMessage(tx, ctxFor(f, sarah), posted.id, 'tampered')),
      ).rejects.toThrow(/not yours to edit/)

      await f.tx((tx) => editMessage(tx, ctxFor(f, owner), posted.id, 'corrected'))
      const msgs = await f.tx((tx) => listMessages(tx, ctxFor(f, owner), ch.id))
      expect(msgs[0]!.body).toBe('corrected')
      // Silently changing what someone said is worse than not allowing edits.
      expect(msgs[0]!.editedAt).toBeTruthy()
    })

    it('soft-deletes rather than removing the row', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'oops' }),
      )
      await f.tx((tx) => deleteMessage(tx, ctxFor(f, owner), posted.id))

      const msgs = await f.tx((tx) => listMessages(tx, ctxFor(f, owner), ch.id))
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.deletedAt).toBeTruthy()
      expect(msgs[0]!.body).toBe('')
    })

    it('cannot rewrite authorship, timing or channel', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      const posted = await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'said it' }),
      )
      await expect(
        f.t.sudo(`update messages set user_id = '${sarah}' where id = '${posted.id}'`),
      ).rejects.toThrow(/SYNC_MESSAGE_IMMUTABLE/)
      await expect(f.t.sudo(`delete from messages where id = '${posted.id}'`)).rejects.toThrow(
        /SYNC_APPEND_ONLY/,
      )
    })
  })

  describe('unread state', () => {
    it('counts other people’s unread messages, not your own', async () => {
      const dm = await f.tx((tx) => openDirectMessage(tx, ctxFor(f, owner), sarah))
      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: dm.id, body: 'a' }))
      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: dm.id, body: 'b' }))

      const ownersView = await f.tx((tx) => listChannels(tx, ctxFor(f, owner)))
      expect(ownersView[0]!.unreadCount).toBe(0)

      const sarahsView = await f.tx((tx) => listChannels(tx, ctxFor(f, sarah)))
      expect(sarahsView[0]!.unreadCount).toBe(2)
      expect(sarahsView[0]!.counterpartName).toBeTruthy()
    })

    it('marking read clears unread and mention counts', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      await f.tx((tx) => joinChannel(tx, ctxFor(f, sarah), ch.id))
      await f.tx((tx) =>
        postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'ping @sarah' }),
      )

      let sarahsView = await f.tx((tx) => listChannels(tx, ctxFor(f, sarah)))
      expect(sarahsView[0]!.unreadCount).toBe(1)
      expect(sarahsView[0]!.mentionCount).toBe(1)

      await f.tx((tx) => markChannelRead(tx, ctxFor(f, sarah), ch.id))

      sarahsView = await f.tx((tx) => listChannels(tx, ctxFor(f, sarah)))
      expect(sarahsView[0]!.unreadCount).toBe(0)
      expect(sarahsView[0]!.mentionCount).toBe(0)
    })

    it('orders channels by most recent activity', async () => {
      const a = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'alpha' }))
      const b = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'beta' }))

      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: a.id, body: 'in alpha' }))
      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: b.id, body: 'in beta' }))

      const list = await f.tx((tx) => listChannels(tx, ctxFor(f, owner)))
      expect(list[0]!.name).toBe('beta')
    })
  })

  describe('reading permissions', () => {
    it('a non-member cannot read a channel’s messages', async () => {
      const ch = await f.tx((tx) => createChannel(tx, ctxFor(f, owner), { name: 'general' }))
      await f.tx((tx) => postMessage(tx, ctxFor(f, owner), { channelId: ch.id, body: 'secret' }))

      await expect(f.tx((tx) => listMessages(tx, ctxFor(f, sarah), ch.id))).rejects.toThrow(
        /not a member/,
      )
    })
  })
})
