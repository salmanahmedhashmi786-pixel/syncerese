import { uuidv7 } from 'uuidv7'

/**
 * UUIDv7 primary keys, generated application-side.
 *
 * v7 is time-sortable, so it indexes like a sequence without leaking row counts
 * the way a bigint identity does — a competitor should not be able to infer how
 * many invoices a tenant has issued from an ID.
 *
 * Generated in the app rather than by Postgres because `uuidv7()` is only
 * built in from Postgres 18, and depending on the `pg_uuidv7` extension would
 * restrict which managed providers can host this. It also means an EU shard
 * (see `organizations.region`) can be split off later with no ID collisions.
 */
export const newId = (): string => uuidv7()

/** Cheap shape check before a value ever reaches a uuid-typed column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
