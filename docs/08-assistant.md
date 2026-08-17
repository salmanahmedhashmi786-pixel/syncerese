# The AI assistant

"✦ Ask ERP", the right-docked panel. MUST DO #12.

---

## The constraint everything follows from

**The assistant must never state a figure it did not retrieve from the tenant's own data.**

In a finance product this is not a quality target, it is the product. A receivables figure
that is wrong-but-plausible is worse than no assistant at all: it will be quoted in a
meeting, and the first time it is caught the customer stops trusting every number the
system shows them, including the correct ones.

Prompting a model not to invent numbers reduces the rate. It does not make the claim
checkable. So there are four independent barriers, and none of them is the prompt.

---

## 1. A closed catalogue, not text-to-SQL

The model does not write queries. It picks a **name** from
[`src/assistant/catalogue.ts`](../src/assistant/catalogue.ts) and fills in typed parameters.

Text-to-SQL is the obvious design and the wrong one, for a reason that has nothing to do
with injection. A model that writes a subtly wrong query — the wrong join, a missing status
filter, credit notes counted as revenue — returns a number that is wrong and looks
completely plausible. RLS does not help: the query is legitimate and correctly scoped. It
is simply not the number the customer's accountant would arrive at.

Every entry reuses the same SQL fragments as the rest of the application (`outstanding()`,
`signedBaseTotal()`, `excludeCreditNotes()`), so the assistant **cannot disagree with the
invoice list** about what a customer owes. A test asserts exactly that: its totals must
equal the aging report's.

Each entry declares a required permission, a hard row cap (50), and which of its columns
are figures.

## 2. Permissions, by omission

The catalogue is filtered to what the asking user may read **before** the tools are
described to the model. A tool that is never described cannot be called — stronger than
refusing the call afterwards. The permission is re-checked at the point of use anyway, so a
bug in the filtering cannot become a data leak.

Every query runs in the caller's tenant transaction, under RLS, as the asking user. The
assistant has **no privileged data path**, so tenant isolation and RBAC are inherited
rather than reimplemented — there is no second place for an isolation bug to hide.

## 3. Parameter validation

Whatever the model supplies is parsed by the entry's own zod schema before anything touches
the database. This is not ceremony: the first version of the catalogue filtered invoices on
`direction = 'sale'` where the column only ever holds `'ar'` or `'ap'`, and the result was a
confident, well-formatted **€0.00** sitting next to a dashboard reading €123,702.88.

## 4. The numeric grounding check

[`src/assistant/grounding.ts`](../src/assistant/grounding.ts). Every figure in the drafted
answer is checked against the figures actually retrieved. If one cannot be traced, the draft
is **rejected** and the user sees a refusal instead.

Grounded means one of:

- a retrieved value, in minor units (`120400`) or major units (`1,204.00`, and the European
  `1.204,00`)
- the row count, and small integers up to it
- the sum of a whole column — but only columns declared **additive**. Totalling
  `daysOverdue` across invoices 12 and 5 days late gives 17, a fact about nothing, and
  admitting it would let the assistant say "17" and be believed
- a date part appearing in the rows

Everything else is rejected, including arithmetic the file does not model — averages,
percentages, differences between rows. That is the intended trade: **a refusal is
recoverable, a confidently wrong figure is not.**

Rejections are recorded (`assistant_messages.grounded = false`) and indexed, because a
rising rate is the early warning that the model, the catalogue or the prompt has drifted,
and it is invisible otherwise. The rejected draft itself is not stored — its figures may be
the wrong ones.

---

## The audit trail

Every assistant message carries `retrieved_query` (which catalogue entries ran, with what
parameters) and `result_row_count`. For any figure the assistant ever stated, those two
columns reconstruct exactly which rows it was summarising.

The panel shows the short version under each answer — `receivables.summary · 1 row` — so
somebody can decide whether to trust a figure without opening the records. An answer with
no citation retrieved nothing, and the panel says so rather than hiding it.

Conversations are scoped **per user**, not per workspace: a thread can hold figures the
asker's permissions allowed and a colleague's do not.

---

## Running without a model

`ANTHROPIC_API_KEY` is optional. A self-hosted installation on an isolated network cannot
call anybody's API, and that is a supported way to run this product rather than a broken
one.

With no key, the assistant falls back to **deterministic routing**: the question is matched
to a catalogue entry by keyword and the rows are rendered as a table by the application. No
drafting step, so nothing to check — every figure is formatted straight out of the result
set. Less fluent, equally truthful, and it never leaves the building.

The panel says so plainly and offers the questions it can answer.

> One caution about keyword routing, preserved because it cost real debugging: "how much are
> we **owed**" contains the substring "we owe". The unanchored pattern read it as payables
> and answered with the amount owed to suppliers — the opposite of the question, as a real
> number in the right format, with nothing to notice. The patterns are word-anchored and
> there is a test.

## Configuring a model

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001   # optional
```

Haiku by default: the work is choosing one of seven lookups and writing two sentences about
the rows that come back, not reasoning.

The API is called over plain `fetch` — no SDK dependency to keep current, audit and bundle
into a self-hosted image, for roughly eighty lines of code.

**What leaves your deployment**: the user's question, the tool definitions, and the
retrieved rows. Those rows are your tenant's business data. If that is unacceptable for a
given customer, leave the key unset and the deterministic mode gives them a working
assistant that makes no outbound calls at all.

---

## Adding a lookup

1. Add an entry to `CATALOGUE` with its permission, zod params, hand-written JSON schema,
   `numericFields` and `sumFields`.
2. Reuse the application's existing SQL fragments. Do not write a second definition of
   "outstanding".
3. `sumFields` must be a subset of `numericFields`, and must contain only columns it is
   meaningful to add up. There is a test for the first; the second is judgement.
4. Add a routing rule if the deterministic fallback should reach it.

The suite runs every entry against a real schema, because column names in hand-written SQL
do not typecheck.
