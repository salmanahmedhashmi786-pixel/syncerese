import type { CatalogueEntry } from './catalogue'

/**
 * The model, over plain fetch.
 *
 * No SDK dependency: this uses two endpoints of the Messages API and a JSON
 * shape that has been stable for years. A dependency that has to be kept
 * current, audited and bundled into a self-hosted image is a poor trade for
 * roughly eighty lines.
 *
 * OPTIONAL BY DESIGN
 *
 * `ANTHROPIC_API_KEY` may be absent — a self-hosted installation on an isolated
 * network has no way to call anybody's API, and that is a legitimate way to run
 * this product rather than a broken one. When it is absent the assistant falls
 * back to deterministic routing (see `route.ts`): the question is matched to a
 * catalogue entry by keyword and the rows are rendered as a table with no prose
 * around them. Less fluent, equally truthful, and it never leaves the building.
 */

const API = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'

/** Small and fast. The work here is choosing one of seven lookups and writing
 *  two sentences about the rows that come back — not reasoning. */
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

const TIMEOUT_MS = 30_000

export const modelConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY)

export type ToolUse = { id: string; name: string; input: Record<string, unknown> }

export type ModelTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; uses: ToolUse[] }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type Turn =
  | { role: 'user'; content: string | unknown[] }
  | { role: 'assistant'; content: unknown[] }

/**
 * The instruction that shapes every answer.
 *
 * It says "do not invent figures", and that instruction is NOT what makes the
 * guarantee — `grounding.ts` is. This wording exists to raise the rate at which
 * the model produces an answer that passes, so that users see refusals rarely.
 * If this prompt were the only defence, the feature would not be shippable.
 */
export const SYSTEM_PROMPT = `You are the assistant inside Syncrèse, an ERP system, answering questions about ONE company's own business data.

How you must work:

- To answer anything factual, call a tool. The tools are the only way to see data. You have no memory of this company and no knowledge of its figures.
- State ONLY figures that appear in the tool results. Never estimate, never extrapolate, never carry a number over from a previous answer, and never compute a percentage, average or difference that is not in the results.
- Amounts come back in MINOR UNITS with a currency code: 120400 with "EUR" is €1,204.00. Convert exactly, and always show the currency.
- If the tools return nothing, say so plainly. "No invoices match that" is a good answer. Inventing a plausible one is not.
- If a question cannot be answered with the tools available, say what you cannot see rather than guessing. The user may simply lack permission for it.

Style: brief and concrete. Two or three sentences, or a short list. No preamble, no "certainly", no offers to help further. This is a work tool used alongside a table of the same data.`

type MessagesResponse = {
  content?: ContentBlock[]
  stop_reason?: string
  error?: { message?: string }
}

/**
 * One exchange with the model.
 *
 * Returns either prose or a set of tool calls; the caller runs the tools and
 * calls again with the results. The loop lives in `service.ts` so that the
 * permission checks and the audit trail stay next to each other.
 */
export async function askModel(
  messages: Turn[],
  tools: CatalogueEntry[],
  signal?: AbortSignal,
): Promise<ModelTurn> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
        tools: tools.map((t) => ({
          name: toolName(t.name),
          description: t.description,
          input_schema: t.schema,
        })),
      }),
      signal: controller.signal,
    })

    const body = (await response.json().catch(() => ({}))) as MessagesResponse

    if (!response.ok) {
      // The provider's message can quote the request, which contains this
      // tenant's question. It goes to the server log, never to the user.
      console.error('[assistant] model error', response.status, body.error?.message)
      throw new Error(`The assistant is unavailable (HTTP ${response.status}).`)
    }

    const blocks = body.content ?? []
    const uses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use',
    )
    if (uses.length > 0) {
      return {
        kind: 'tools',
        uses: uses.map((u) => ({ id: u.id, name: fromToolName(u.name), input: u.input ?? {} })),
      }
    }

    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()

    return { kind: 'text', text }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Catalogue names contain dots (`invoices.outstanding`); tool names in the API
 * are restricted to letters, digits and underscores. Mapped rather than
 * renaming the catalogue, because the dotted names are what appears in the
 * audit trail and they read better there.
 */
export const toolName = (name: string): string => name.replace(/\./g, '__')
export const fromToolName = (name: string): string => name.replace(/__/g, '.')
