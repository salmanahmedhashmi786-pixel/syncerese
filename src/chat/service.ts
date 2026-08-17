import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  channelMembers,
  channels,
  messageMentions,
  messageRefs,
  messages,
  notifications,
} from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import type { RequestContext } from '@/server/context'

/**
 * Internal team chat (MUST DO #13).
 *
 * Small on purpose: DMs, channels, groups, @mentions and deep links into ERP
 * records. What makes it worth having is the last of those — "check INV-00042"
 * becomes a click into the real record, which no external chat tool can do.
 */

const rowsOf = <T>(res: unknown): T[] => (res as { rows: T[] }).rows

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const createChannelSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[^\s#@][^#@]*$/, 'Channel names cannot contain # or @'),
  topic: z.string().max(200).optional(),
  isPrivate: z.boolean().default(false),
  memberIds: z.array(z.string().uuid()).max(200).default([]),
})

export async function createChannel(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<{ id: string }> {
  const parsed = createChannelSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid channel', parsed.error.issues)
  }
  const { name, topic, isPrivate, memberIds } = parsed.data

  const id = newId()
  await tx.insert(channels).values({
    id,
    organizationId: ctx.organizationId,
    type: 'channel',
    name: name.trim(),
    topic: topic ?? null,
    isPrivate,
    createdBy: ctx.userId,
  })

  // The creator is always a member — a channel you cannot post in is not a
  // channel you meant to create.
  const uniqueMembers = [...new Set([ctx.userId, ...memberIds])]
  await tx.insert(channelMembers).values(
    uniqueMembers.map((userId) => ({
      organizationId: ctx.organizationId,
      channelId: id,
      userId,
      role: userId === ctx.userId ? ('admin' as const) : ('member' as const),
    })),
  )

  return { id }
}

/** Both user ids, sorted — so A→B and B→A resolve to the same conversation
 *  instead of two half-histories. */
export const dmKeyFor = (a: string, b: string): string => [a, b].sort().join(':')

/**
 * Finds or creates the DM between two people.
 *
 * Idempotent by construction: the unique index on (organization, dm_key) means
 * two simultaneous "message Sarah" clicks cannot produce two conversations.
 */
export async function openDirectMessage(
  tx: TenantTx,
  ctx: RequestContext,
  otherUserId: string,
): Promise<{ id: string; created: boolean }> {
  if (otherUserId === ctx.userId) {
    throw new AppError('VALIDATION_FAILED', 'You cannot open a direct message with yourself')
  }

  // Both parties must be members of THIS organization. Without this check a
  // user id from another tenant could be used to create a channel that leaks
  // its existence across the boundary.
  const isMember = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from memberships
       where organization_id = ${ctx.organizationId}
         and user_id = ${otherUserId}
         and status = 'active'
    `),
  )[0]!
  if (Number(isMember.n) === 0) {
    throw new AppError('NOT_FOUND', 'That person is not a member of this organization')
  }

  const key = dmKeyFor(ctx.userId, otherUserId)

  const existing = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from channels
       where organization_id = ${ctx.organizationId} and dm_key = ${key}
       limit 1
    `),
  )[0]

  if (existing) return { id: existing.id, created: false }

  const id = newId()
  await tx.insert(channels).values({
    id,
    organizationId: ctx.organizationId,
    type: 'dm',
    name: null,
    dmKey: key,
    isPrivate: true,
    createdBy: ctx.userId,
  })
  await tx.insert(channelMembers).values([
    { organizationId: ctx.organizationId, channelId: id, userId: ctx.userId },
    { organizationId: ctx.organizationId, channelId: id, userId: otherUserId },
  ])

  return { id, created: true }
}

export async function joinChannel(
  tx: TenantTx,
  ctx: RequestContext,
  channelId: string,
): Promise<void> {
  const channel = (
    await tx
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.organizationId, ctx.organizationId)))
      .limit(1)
  )[0]
  if (!channel) throw new AppError('NOT_FOUND', 'Channel not found')

  // A private channel or a DM is joined by invitation, not by knowing its id.
  if (channel.isPrivate || channel.type === 'dm') {
    throw new AppError('FORBIDDEN', 'This channel is private — ask a member to add you')
  }

  await tx
    .insert(channelMembers)
    .values({ organizationId: ctx.organizationId, channelId, userId: ctx.userId })
    .onConflictDoNothing()
}

// ---------------------------------------------------------------------------
// Mentions and record references
// ---------------------------------------------------------------------------

/**
 * `@name` — letters, digits, dot, dash, underscore.
 *
 * The lookbehind is load-bearing: without it "mail me at bob@example.com"
 * parses as a mention of `example.com`, which would notify a stranger, or
 * silently fail to, depending on who happens to be called that.
 */
const MENTION_RE = /(?<![A-Za-z0-9._-])@([a-z0-9][a-z0-9._-]{0,63})/gi

/**
 * Document references the parser recognises, mapped to the module that owns
 * them. Derived from the actual document-number prefixes the sequences issue,
 * so a reference cannot point at a module that does not exist.
 */
const REF_PATTERNS: { re: RegExp; module: string; table: string; column: string }[] = [
  { re: /\b(INV-\d{4,})\b/gi, module: 'invoices', table: 'invoices', column: 'invoice_no' },
  { re: /\b(BILL-\d{4,})\b/gi, module: 'invoices', table: 'invoices', column: 'invoice_no' },
  { re: /\b(SO-\d{4,})\b/gi, module: 'sales-orders', table: 'sales_orders', column: 'order_no' },
  { re: /\b(PO-\d{4,})\b/gi, module: 'purchase-orders', table: 'purchase_orders', column: 'po_no' },
  { re: /\b(BP-\d{4,})\b/gi, module: 'customers', table: 'business_partners', column: 'partner_no' },
  { re: /\b(DL-\d{4,})\b/gi, module: 'deals', table: 'deals', column: 'deal_no' },
]

export function extractMentions(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase()))]
}

export function extractReferences(body: string): { label: string; module: string }[] {
  const out: { label: string; module: string }[] = []
  const seen = new Set<string>()
  for (const pattern of REF_PATTERNS) {
    for (const match of body.matchAll(pattern.re)) {
      const label = match[1]!.toUpperCase()
      if (seen.has(label)) continue
      seen.add(label)
      out.push({ label, module: pattern.module })
    }
  }
  return out
}

/**
 * Resolves `@handle` to organization members.
 *
 * Matched against the local part of the email and the display name, since
 * there is no separate username. Only ACTIVE members resolve — mentioning a
 * departed colleague should not create a notification nobody will read.
 */
async function resolveMentions(
  tx: TenantTx,
  organizationId: string,
  handles: string[],
): Promise<{ userId: string; handle: string; name: string }[]> {
  if (handles.length === 0) return []

  const rows = rowsOf<{ id: string; email: string; name: string | null }>(
    await tx.execute(sql`
      select u.id, u.email, u.name
        from memberships m
        join users u on u.id = m.user_id
       where m.organization_id = ${organizationId}
         and m.status = 'active'
    `),
  )

  const wanted = new Set(handles.map((h) => h.toLowerCase()))
  const out: { userId: string; handle: string; name: string }[] = []

  for (const row of rows) {
    const local = row.email.split('@')[0]!.toLowerCase()
    const compact = (row.name ?? '').toLowerCase().replace(/\s+/g, '')
    const first = (row.name ?? '').split(/\s+/)[0]?.toLowerCase() ?? ''

    const handle = [local, compact, first].find((c) => c && wanted.has(c))
    if (handle) out.push({ userId: row.id, handle, name: row.name ?? row.email })
  }
  return out
}

/** Looks up each `INV-00042`-style reference and keeps only the ones that
 *  resolve to a real record in this tenant. */
async function resolveReferences(
  tx: TenantTx,
  organizationId: string,
  refs: { label: string; module: string }[],
): Promise<{ module: string; entityId: string; label: string }[]> {
  const out: { module: string; entityId: string; label: string }[] = []

  for (const ref of refs) {
    const pattern = REF_PATTERNS.find((p) => p.module === ref.module)
    if (!pattern) continue

    // Table and column come from the constant above, never from user input.
    const found = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from ${sql.raw(pattern.table)}
         where organization_id = ${organizationId}
           and upper(${sql.raw(pattern.column)}) = ${ref.label}
         limit 1
      `),
    )[0]

    if (found) out.push({ module: ref.module, entityId: found.id, label: ref.label })
  }
  return out
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export const postSchema = z.object({
  channelId: z.string().uuid(),
  body: z.string().min(1).max(4000),
  replyToId: z.string().uuid().optional(),
})

export type PostedMessage = {
  id: string
  mentions: { userId: string; name: string }[]
  references: { module: string; entityId: string; label: string }[]
}

export async function postMessage(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<PostedMessage> {
  const parsed = postSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid message', parsed.error.issues)
  }
  const { channelId, body, replyToId } = parsed.data

  // Membership is also enforced by trigger; checking here produces a usable
  // error instead of a raw Postgres exception.
  const member = (
    await tx
      .select()
      .from(channelMembers)
      .where(
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, ctx.userId)),
      )
      .limit(1)
  )[0]
  if (!member) throw new AppError('FORBIDDEN', 'You are not a member of this channel')

  const id = newId()
  await tx.insert(messages).values({
    id,
    organizationId: ctx.organizationId,
    channelId,
    userId: ctx.userId,
    body: body.trim(),
    replyToId: replyToId ?? null,
  })

  const mentioned = await resolveMentions(tx, ctx.organizationId, extractMentions(body))
  const references = await resolveReferences(tx, ctx.organizationId, extractReferences(body))

  // Mentioning yourself should not notify you.
  const others = mentioned.filter((m) => m.userId !== ctx.userId)

  if (others.length > 0) {
    await tx.insert(messageMentions).values(
      others.map((m) => ({
        organizationId: ctx.organizationId,
        messageId: id,
        userId: m.userId,
      })),
    )

    await tx.insert(notifications).values(
      others.map((m) => ({
        id: newId(),
        organizationId: ctx.organizationId,
        userId: m.userId,
        type: 'mention',
        title: 'You were mentioned',
        body: body.slice(0, 140),
        href: `/chat?channel=${channelId}&message=${id}`,
        payload: { channelId, messageId: id },
      })),
    )
  }

  if (references.length > 0) {
    await tx.insert(messageRefs).values(
      references.map((r) => ({
        organizationId: ctx.organizationId,
        messageId: id,
        module: r.module,
        entityId: r.entityId,
        label: r.label,
      })),
    )
  }

  // Posting counts as reading your own message.
  await tx
    .update(channelMembers)
    .set({ lastReadAt: new Date() })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, ctx.userId)))

  return {
    id,
    mentions: others.map((m) => ({ userId: m.userId, name: m.name })),
    references,
  }
}

export async function editMessage(
  tx: TenantTx,
  ctx: RequestContext,
  messageId: string,
  body: string,
): Promise<void> {
  const text = body.trim()
  if (!text || text.length > 4000) {
    throw new AppError('VALIDATION_FAILED', 'Message body must be 1–4000 characters')
  }

  const result = await tx
    .update(messages)
    .set({ body: text })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.organizationId, ctx.organizationId),
        // Only the author. Anyone editing anyone's words would make the
        // conversation unciteable — which matters when it links to invoices.
        eq(messages.userId, ctx.userId),
      ),
    )
    .returning({ id: messages.id })

  if (result.length === 0) {
    throw new AppError('NOT_FOUND', 'Message not found, or it is not yours to edit')
  }
}

export async function deleteMessage(
  tx: TenantTx,
  ctx: RequestContext,
  messageId: string,
): Promise<void> {
  const result = await tx
    .update(messages)
    .set({ deletedAt: new Date(), body: '' })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.organizationId, ctx.organizationId),
        eq(messages.userId, ctx.userId),
      ),
    )
    .returning({ id: messages.id })

  if (result.length === 0) {
    throw new AppError('NOT_FOUND', 'Message not found, or it is not yours to delete')
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ChannelSummary = {
  id: string
  type: string
  name: string | null
  topic: string | null
  isPrivate: boolean
  memberCount: number
  lastMessageAt: string | null
  unreadCount: number
  mentionCount: number
  /** For DMs: who the conversation is with. */
  counterpartName: string | null
}

export async function listChannels(
  tx: TenantTx,
  ctx: RequestContext,
): Promise<ChannelSummary[]> {
  return rowsOf<ChannelSummary>(
    await tx.execute(sql`
      select
        c.id,
        c.type,
        c.name,
        c.topic,
        c.is_private            as "isPrivate",
        c.last_message_at       as "lastMessageAt",
        (select count(*)::int from channel_members m2 where m2.channel_id = c.id)
                                as "memberCount",
        (select count(*)::int from messages msg
          where msg.channel_id = c.id
            and msg.deleted_at is null
            and msg.user_id is distinct from ${ctx.userId}
            and (m.last_read_at is null or msg.created_at > m.last_read_at))
                                as "unreadCount",
        (select count(*)::int from message_mentions mm
           join messages msg2 on msg2.id = mm.message_id
          where mm.user_id = ${ctx.userId}
            and mm.read_at is null
            and msg2.channel_id = c.id)
                                as "mentionCount",
        (select u.name from channel_members m3
           join users u on u.id = m3.user_id
          where m3.channel_id = c.id and m3.user_id <> ${ctx.userId}
          limit 1)              as "counterpartName"
      from channel_members m
      join channels c on c.id = m.channel_id
      where m.organization_id = ${ctx.organizationId}
        and m.user_id = ${ctx.userId}
        and c.archived_at is null
      order by c.last_message_at desc nulls last, c.name
    `),
  )
}

export type ChatMessage = {
  id: string
  body: string
  userId: string | null
  authorName: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  isSystem: boolean
  refs: { module: string; entityId: string; label: string }[]
}

export async function listMessages(
  tx: TenantTx,
  ctx: RequestContext,
  channelId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<ChatMessage[]> {
  const member = (
    await tx
      .select()
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, ctx.userId)))
      .limit(1)
  )[0]
  if (!member) throw new AppError('FORBIDDEN', 'You are not a member of this channel')

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)

  const rows = rowsOf<ChatMessage & { refs: unknown }>(
    await tx.execute(sql`
      select
        m.id, m.body, m.user_id as "userId", u.name as "authorName",
        m.created_at as "createdAt", m.edited_at as "editedAt",
        m.deleted_at as "deletedAt", m.is_system as "isSystem",
        coalesce((
          select json_agg(json_build_object(
                   'module', r.module, 'entityId', r.entity_id, 'label', r.label))
            from message_refs r where r.message_id = m.id
        ), '[]'::json) as refs
      from messages m
      left join users u on u.id = m.user_id
      where m.channel_id = ${channelId}
        and m.organization_id = ${ctx.organizationId}
        ${opts.before ? sql`and m.created_at < ${opts.before}` : sql``}
      -- Tie-break on id, not just created_at. Postgres now() is TRANSACTION
      -- start time, so every message written in one transaction shares a
      -- timestamp and ordering by created_at alone is arbitrary — two messages
      -- posted together would display in whichever order the planner felt
      -- like. Ids are UUIDv7 and therefore time-sortable, so this is both
      -- stable and chronologically correct.
      order by m.created_at desc, m.id desc
      limit ${limit}
    `),
  )

  // Newest-first for the query (so LIMIT takes the recent ones), oldest-first
  // for display.
  return rows.reverse().map((r) => ({
    ...r,
    refs: (r.refs as ChatMessage['refs']) ?? [],
  }))
}

export async function markChannelRead(
  tx: TenantTx,
  ctx: RequestContext,
  channelId: string,
): Promise<void> {
  await tx
    .update(channelMembers)
    .set({ lastReadAt: new Date() })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, ctx.userId)))

  await tx.execute(sql`
    update message_mentions mm
       set read_at = now()
      from messages m
     where mm.message_id = m.id
       and mm.user_id = ${ctx.userId}
       and mm.read_at is null
       and m.channel_id = ${channelId}
  `)
}

/** Members of this organization, for the mention picker and the DM list. */
export async function listOrganizationMembers(tx: TenantTx, ctx: RequestContext) {
  return rowsOf<{ id: string; name: string | null; email: string; handle: string }>(
    await tx.execute(sql`
      select u.id, u.name, u.email, split_part(u.email, '@', 1) as handle
        from memberships m
        join users u on u.id = m.user_id
       where m.organization_id = ${ctx.organizationId}
         and m.status = 'active'
       order by u.name nulls last, u.email
    `),
  )
}

export async function unreadNotifications(tx: TenantTx, ctx: RequestContext, limit = 20) {
  return rowsOf<{
    id: string
    type: string
    title: string
    body: string | null
    href: string | null
    createdAt: string
  }>(
    await tx.execute(sql`
      select id, type, title, body, href, created_at as "createdAt"
        from notifications
       where organization_id = ${ctx.organizationId}
         and user_id = ${ctx.userId}
         and read_at is null
       order by created_at desc
       limit ${limit}
    `),
  )
}
