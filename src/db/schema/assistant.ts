import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * AI assistant conversations (MUST DO #12).
 *
 * See drizzle/0020 for the reasoning. The short version: `retrievedQuery` and
 * `resultRowCount` exist so that for any figure the assistant stated, you can
 * reconstruct which rows of the tenant's own data it was summarising. An
 * assistant that says "you are owed 47,300" is either quoting the ledger or
 * inventing it, and from the outside those look the same.
 */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Per USER, not per organization. The assistant answers under the asker's
     *  permissions, so a thread can hold figures a colleague may not see. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [index('assistant_conversations_org_user_idx').on(t.organizationId, t.userId, t.createdAt)],
)

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** `[{ query, params, rows }]` — which catalogue entries ran and with what.
     *  Never free-form SQL: the model picks a NAME from a closed catalogue, so
     *  this records a decision rather than a statement. */
    retrievedQuery: jsonb('retrieved_query'),
    resultRowCount: integer('result_row_count'),
    /** Whether every figure in the answer traced back to a retrieved row. False
     *  means the user was shown a refusal instead of the draft. */
    grounded: boolean('grounded'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assistant_messages_conversation_idx').on(t.conversationId, t.createdAt),
    check('assistant_messages_role', sql`${t.role} in ('user','assistant')`),
  ],
)
