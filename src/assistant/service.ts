import { sql } from 'drizzle-orm'
import { assistantConversations, assistantMessages } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { type RequestContext, requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { formatMoney } from '@/finance/money'
import { catalogueFor, type CatalogueEntry, type CatalogueRow } from './catalogue'
import { checkGrounding } from './grounding'
import { askModel, modelConfigured, toolName, type ModelTurn, type Turn } from './model'
import { routeQuestion } from './route'

/**
 * The assistant (MUST DO #12).
 *
 * The order of operations here is the security design, so it is worth stating
 * plainly:
 *
 *   1. The catalogue is filtered to what THIS USER may read. A tool that is
 *      never described cannot be called — stronger than refusing it afterwards.
 *   2. The model picks a name and parameters. It never writes a query.
 *   3. Parameters are validated by the entry's own zod schema before anything
 *      touches the database.
 *   4. The query runs in the caller's tenant transaction, under RLS, as the
 *      asking user. There is no privileged path.
 *   5. The drafted answer is checked against the retrieved figures. Ungrounded
 *      answers are replaced, not shown.
 *   6. What ran, with what, and whether it passed is written to the message row.
 *
 * Every one of those is a separate barrier and none of them is the prompt.
 */

/** How many times the model may call tools before it must answer. Two rounds
 *  covers "find the partner, then find their invoices"; more than that is a
 *  question this catalogue cannot answer, and looping costs the user money. */
const MAX_TOOL_ROUNDS = 3

export type AssistantAnswer = {
  conversationId: string
  answer: string
  /** What was looked up, for the citation line under the answer. The user
   *  should be able to see that a real query ran without reading the audit
   *  trail. */
  retrievals: { query: string; rows: number }[]
  grounded: boolean
  /** True when the answer came from deterministic routing because no model is
   *  configured. The panel says so rather than implying a conversation. */
  deterministic: boolean
}

/**
 * Seams for the tests.
 *
 * The grounding rejection is the single most important behaviour in this
 * feature and it cannot be exercised against a real model — you cannot make a
 * model reliably produce a wrong number on demand. So the model call is
 * injectable, and the tests drive it with a stub that states a figure nobody
 * retrieved.
 */
export type AskDeps = {
  askModel?: (messages: Turn[], tools: CatalogueEntry[]) => Promise<ModelTurn>
  modelConfigured?: () => boolean
}

const REFUSAL =
  'I could not verify every figure in my answer against your data, so I have not shown it. ' +
  'Please try asking more specifically, or check the records directly.'

// ---------------------------------------------------------------------------

export async function ask(
  tx: TenantTx,
  ctx: RequestContext,
  question: string,
  conversationId?: string,
  deps: AskDeps = {},
): Promise<AssistantAnswer> {
  const trimmed = question.trim()
  if (trimmed === '') throw new AppError('VALIDATION_FAILED', 'Ask a question.')
  if (trimmed.length > 2000) {
    throw new AppError('VALIDATION_FAILED', 'That question is too long.')
  }

  const available = catalogueFor(ctx)
  if (available.length === 0) {
    throw new AppError(
      'FORBIDDEN',
      'Your role does not have read access to anything the assistant can look up.',
    )
  }

  const conversation = await ensureConversation(tx, ctx, conversationId, trimmed)

  await tx.insert(assistantMessages).values({
    id: newId(),
    organizationId: ctx.organizationId,
    conversationId: conversation,
    role: 'user',
    content: trimmed,
  })

  const hasModel = (deps.modelConfigured ?? modelConfigured)()
  const result = hasModel
    ? await answerWithModel(tx, ctx, trimmed, available, deps.askModel ?? askModel)
    : await answerDeterministically(tx, ctx, trimmed, available)

  await tx.insert(assistantMessages).values({
    id: newId(),
    organizationId: ctx.organizationId,
    conversationId: conversation,
    role: 'assistant',
    content: result.answer,
    // The audit trail. For any figure this answer stated, these two columns are
    // how you reconstruct which rows it was summarising.
    retrievedQuery: result.retrievals,
    resultRowCount: result.retrievals.reduce((n, r) => n + r.rows, 0),
    grounded: result.grounded,
  })

  return { conversationId: conversation, ...result }
}

// ---------------------------------------------------------------------------

type Answered = Omit<AssistantAnswer, 'conversationId'>

async function answerWithModel(
  tx: TenantTx,
  ctx: RequestContext,
  question: string,
  available: CatalogueEntry[],
  callModel: (messages: Turn[], tools: CatalogueEntry[]) => Promise<ModelTurn>,
): Promise<Answered> {
  const messages: Turn[] = [{ role: 'user', content: question }]
  const retrievals: { query: string; rows: number }[] = []
  const forGrounding: {
    rows: CatalogueRow[]
    numericFields: readonly string[]
    sumFields: readonly string[]
  }[] = []

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const turn = await callModel(messages, available)

    if (turn.kind === 'text') {
      return finish(turn.text, retrievals, forGrounding, false)
    }

    messages.push({
      role: 'assistant',
      content: turn.uses.map((u) => ({
        type: 'tool_use',
        id: u.id,
        name: toolName(u.name),
        input: u.input,
      })),
    })

    const results: unknown[] = []
    for (const use of turn.uses) {
      const executed = await runTool(tx, ctx, available, use.name, use.input)
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(executed.payload),
        ...(executed.error ? { is_error: true } : {}),
      })
      if (!executed.error) {
        retrievals.push({ query: use.name, rows: executed.rows.length })
        forGrounding.push({
          rows: executed.rows,
          numericFields: executed.entry!.numericFields,
          sumFields: executed.entry!.sumFields,
        })
      }
    }
    messages.push({ role: 'user', content: results })
  }

  // Out of rounds. Better to say so than to let it answer without the lookup it
  // was still reaching for.
  return {
    answer:
      'I could not narrow that down with the lookups available. Try naming the customer, ' +
      'the invoice, or the account you mean.',
    retrievals,
    grounded: true,
    deterministic: false,
  }
}

/** Runs one tool call. Everything the model supplied is validated here. */
async function runTool(
  tx: TenantTx,
  ctx: RequestContext,
  available: CatalogueEntry[],
  name: string,
  input: Record<string, unknown>,
): Promise<{
  entry?: CatalogueEntry
  rows: CatalogueRow[]
  payload: unknown
  error?: boolean
}> {
  // Looked up in the FILTERED list, not the whole catalogue. A model that
  // invents a tool name, or repeats one it saw in another workspace, gets a
  // plain error rather than a query.
  const entry = available.find((e) => e.name === name)
  if (!entry) {
    return { rows: [], payload: { error: 'No such lookup.' }, error: true }
  }

  const parsed = entry.params.safeParse(input)
  if (!parsed.success) {
    return {
      rows: [],
      payload: { error: 'Invalid parameters', detail: parsed.error.issues.slice(0, 3) },
      error: true,
    }
  }

  // Belt and braces. `available` was already filtered by permission; this
  // re-checks at the point of use, so a bug in the filtering cannot become a
  // data leak.
  requirePermission(ctx, entry.permission)

  try {
    const rows = await entry.run(tx, ctx, parsed.data as never)
    return { entry, rows, payload: { rows, rowCount: rows.length } }
  } catch (err) {
    // The database error text can quote table and column names. It is useful in
    // the log and is not something to hand to a model or a user.
    console.error('[assistant] retrieval failed', name, err)
    return { rows: [], payload: { error: 'That lookup failed.' }, error: true }
  }
}

function finish(
  draft: string,
  retrievals: { query: string; rows: number }[],
  forGrounding: {
    rows: CatalogueRow[]
    numericFields: readonly string[]
    sumFields: readonly string[]
  }[],
  deterministic: boolean,
): Answered {
  const check = checkGrounding(draft, forGrounding)
  if (!check.grounded) {
    // Logged so a rising rate is visible. The draft itself is NOT logged: it
    // contains the tenant's figures, and the point of rejecting it is that they
    // may be wrong ones.
    console.warn('[assistant] ungrounded answer suppressed', {
      ungrounded: check.ungrounded.slice(0, 5),
      retrievals,
    })
    return { answer: REFUSAL, retrievals, grounded: false, deterministic }
  }
  return { answer: draft, retrievals, grounded: true, deterministic }
}

// ---------------------------------------------------------------------------

/**
 * No model configured: match the question to a lookup and render the rows.
 *
 * The answer is built by the APPLICATION from the rows, so there is no drafting
 * step and nothing to check — every figure is formatted directly out of the
 * result set. `grounded` is true because it is true by construction.
 */
async function answerDeterministically(
  tx: TenantTx,
  ctx: RequestContext,
  question: string,
  available: CatalogueEntry[],
): Promise<Answered> {
  const routed = routeQuestion(question, available)
  if (!routed) {
    return {
      answer:
        'No AI model is configured on this installation, so I answer a fixed set of ' +
        'questions. Try "what is overdue", "how much are we owed", "who are our biggest ' +
        'customers", or "what needs reordering".',
      retrievals: [],
      grounded: true,
      deterministic: true,
    }
  }

  const executed = await runTool(tx, ctx, available, routed.entry.name, routed.params)
  if (executed.error) {
    return {
      answer: 'That lookup failed. Please try again.',
      retrievals: [],
      grounded: true,
      deterministic: true,
    }
  }

  return {
    answer: renderRows(routed.entry, executed.rows),
    retrievals: [{ query: routed.entry.name, rows: executed.rows.length }],
    grounded: true,
    deterministic: true,
  }
}

/** Rows as text. Amounts formatted with their own currency — never a default,
 *  for the same reason the chat integrations refuse to render one. */
function renderRows(entry: CatalogueEntry, rows: CatalogueRow[]): string {
  if (rows.length === 0) return 'Nothing matched.'

  const lines = rows.slice(0, 20).map((row) => {
    const parts: string[] = []
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue
      if (key === 'currencyCode' || key === 'baseCurrency') continue
      parts.push(`${label(key)}: ${renderValue(entry, row, key, value)}`)
    }
    return `• ${parts.join(' · ')}`
  })

  const more = rows.length > lines.length ? `\n…and ${rows.length - lines.length} more.` : ''
  return lines.join('\n') + more
}

function renderValue(
  entry: CatalogueEntry,
  row: CatalogueRow,
  key: string,
  value: unknown,
): string {
  const currency = row.currencyCode ?? row.baseCurrency
  const isMoney = key.endsWith('Minor') && entry.numericFields.includes(key)
  if (isMoney && typeof currency === 'string' && currency.length === 3) {
    const n = Number(value)
    // formatMoney knows each currency's minor-unit scale, so JPY renders as
    // ¥124,000 rather than ¥1,240.00.
    if (Number.isFinite(n)) return formatMoney(n, currency)
  }
  return String(value)
}

const label = (key: string): string =>
  key
    .replace(/Minor$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()

// ---------------------------------------------------------------------------

async function ensureConversation(
  tx: TenantTx,
  ctx: RequestContext,
  conversationId: string | undefined,
  firstQuestion: string,
): Promise<string> {
  if (conversationId) {
    // Scoped to this USER as well as this tenant: threads can hold figures a
    // colleague has no permission to see, so they are not shared across the
    // workspace.
    const found = await tx.execute(sql`
      select id from assistant_conversations
       where id = ${conversationId}
         and organization_id = ${ctx.organizationId}
         and user_id = ${ctx.userId}
    `)
    if ((found as unknown as { rows: unknown[] }).rows.length > 0) return conversationId
    throw new AppError('NOT_FOUND', 'That conversation no longer exists.')
  }

  const id = newId()
  await tx.insert(assistantConversations).values({
    id,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    title: firstQuestion.slice(0, 120),
  })
  return id
}

/** The visible history for a thread. */
export async function conversationMessages(
  tx: TenantTx,
  ctx: RequestContext,
  conversationId: string,
): Promise<
  { role: string; content: string; grounded: boolean | null; retrievals: unknown }[]
> {
  const res = await tx.execute(sql`
    select m.role, m.content, m.grounded, m.retrieved_query as retrievals
      from assistant_messages m
      join assistant_conversations c on c.id = m.conversation_id
     where m.conversation_id = ${conversationId}
       and m.organization_id = ${ctx.organizationId}
       and c.user_id = ${ctx.userId}
     order by m.created_at
  `)
  return (
    res as unknown as {
      rows: { role: string; content: string; grounded: boolean | null; retrievals: unknown }[]
    }
  ).rows
}
