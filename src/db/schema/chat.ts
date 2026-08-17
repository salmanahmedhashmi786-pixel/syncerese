import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * Internal team chat (MUST DO #13).
 *
 * Deliberately small: DMs, channels, groups, @mentions and deep links to ERP
 * records. No threads, no reactions, no voice, no elaborate channel
 * administration — an explicit AVOID in the brief. The value here is that a
 * conversation can point at invoice INV-00042 and the other person can click
 * straight to it, not that it competes with Slack.
 *
 * Everything is tenant-scoped, so cross-organization messaging is
 * structurally impossible rather than merely unimplemented.
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('channel'),
    /** Null for DMs — a DM is named by who is in it. */
    name: text('name'),
    topic: text('topic'),
    isPrivate: boolean('is_private').notNull().default(false),

    /**
     * Canonical key for a direct message: both user ids sorted and joined.
     *
     * Without it, A messaging B and B messaging A create two separate
     * conversations and half the history goes missing from each side.
     */
    dmKey: text('dm_key'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Denormalised so a channel list can be ordered by recency without
     *  joining every message. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('channels_org_dm_uq').on(t.organizationId, t.dmKey).where(sql`dm_key is not null`),
    uniqueIndex('channels_org_name_uq')
      .on(t.organizationId, t.name)
      .where(sql`type = 'channel' and archived_at is null`),
    index('channels_org_recent_idx').on(t.organizationId, t.lastMessageAt),
    check('channels_type', sql`${t.type} in ('channel','dm','group')`),
    // A DM must carry its key; a named channel must not.
    check(
      'channels_dm_shape',
      sql`(${t.type} = 'dm') = (${t.dmKey} is not null)`,
    ),
    check('channels_named', sql`${t.type} = 'dm' or ${t.name} is not null`),
  ],
)

export const channelMembers = pgTable(
  'channel_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Read state. Kept as a timestamp rather than a message id so it survives
     *  a message being deleted. */
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    muted: boolean('muted').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index('channel_members_user_idx').on(t.organizationId, t.userId),
    check('channel_members_role', sql`${t.role} in ('member','admin')`),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    /** Soft delete: the row survives so replies and mentions do not dangle,
     *  and so an audit question about a conversation still has an answer. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    replyToId: uuid('reply_to_id'),
    /** System messages ("Anna joined") render differently and are not
     *  attributable to a person. */
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The main read path: newest messages in a channel, and the SSE tail.
    index('messages_channel_time_idx').on(t.channelId, t.createdAt),
    index('messages_org_time_idx').on(t.organizationId, t.createdAt),
  ],
)

export const messageMentions = pgTable(
  'message_mentions',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index('message_mentions_unread_idx').on(t.organizationId, t.userId, t.readAt),
  ],
)

/**
 * Deep links from a message to an ERP record.
 *
 * "@Sarah check invoice INV-00042" should be a click, not a copy-paste. The
 * reference is resolved and stored at post time so the link keeps working even
 * if the document is later renumbered in display.
 */
export const messageRefs = pgTable(
  'message_refs',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** The module id the record lives in, e.g. `invoices`. */
    module: text('module').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** What the user typed, e.g. `INV-00042`. */
    label: text('label').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.module, t.entityId] }),
    index('message_refs_entity_idx').on(t.organizationId, t.module, t.entityId),
  ],
)

/** In-app notifications. Mentions create them; workflow actions and, later,
 *  the connectors will too. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** Where clicking it should go. */
    href: text('href'),
    payload: jsonb('payload').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_unread_idx').on(t.organizationId, t.userId, t.readAt, t.createdAt),
  ],
)
