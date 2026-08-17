import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withoutTenantScope } from '@/db/tenant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Liveness and readiness.
 *
 * Platforms restart on a failing health check, so this deliberately checks the
 * thing that would make the process useless — a database it cannot reach —
 * rather than answering 200 because the HTTP server is up. A container that
 * serves errors for every request while reporting healthy is the failure mode
 * this exists to prevent.
 *
 * Unauthenticated callers get a status word and nothing else: a health endpoint
 * is the most-scraped URL on any deployment, and versions, hostnames and error
 * strings are free reconnaissance. Detail requires the same shared secret the
 * dispatch tick uses.
 */

const startedAt = Date.now()

export async function GET(request: Request): Promise<NextResponse> {
  const detailed = isTrusted(request)

  const began = Date.now()
  let probeResult: { schema: boolean; journal: boolean } | null = null
  let migrations: number | null = null
  let detail: string | undefined

  try {
    const handle = await db()
    probeResult = await withoutTenantScope(handle, async (tx) => {
      // Readiness is "the schema this build expects is present", not merely
      // "the socket opened". A container pointed at an empty or wrong database
      // answers a connection test perfectly well and cannot serve a request.
      //
      // to_regclass rather than a select against the table: a missing relation
      // is a PARSE error, so it could not be caught per-statement.
      const probe = await tx.execute(sql`
        select (to_regclass('public.organizations')        is not null) as schema_present,
               (to_regclass('public.__drizzle_migrations') is not null) as journal_present
      `)
      const row = (probe as unknown as {
        rows: { schema_present: boolean; journal_present: boolean }[]
      }).rows[0]

      return {
        schema: row?.schema_present ?? false,
        journal: row?.journal_present ?? false,
      }
    })

    // Absent when the schema was applied by the test harness or the embedded
    // development database, which do not keep the runner's journal. Reported as
    // null rather than 0 so "no journal" is distinguishable from "nothing has
    // ever been migrated".
    //
    // Its own transaction, and its own catch: a failed statement aborts the
    // whole Postgres transaction, so counting inside the probe above would turn
    // a missing SELECT grant on a bookkeeping table into "database
    // unreachable" — a false alarm that would take a service down.
    if (probeResult.journal) {
      try {
        migrations = await withoutTenantScope(handle, async (tx) => {
          const counted = await tx.execute(sql`select count(*)::int as n from __drizzle_migrations`)
          return (counted as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0
        })
      } catch (err) {
        console.warn('[health] could not read the migration journal:', err)
      }
    }
  } catch (err) {
    // The message can carry a connection string or a hostname, so it goes to
    // the log and only to a trusted caller.
    detail = err instanceof Error ? err.message : String(err)
    console.error('[health] database unreachable:', detail)
  }

  const healthy = probeResult !== null && probeResult.schema && migrations !== 0
  const status = healthy ? 200 : 503

  if (!detailed) {
    return NextResponse.json(
      { status: healthy ? 'ok' : 'degraded' },
      { status, headers: { 'cache-control': 'no-store' } },
    )
  }

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      database: probeResult ? 'ok' : 'unreachable',
      schema: probeResult?.schema ? 'present' : 'missing',
      // Zero means the process is talking to a database that has never been
      // migrated — pointing at the wrong one is the usual cause, and it is
      // otherwise indistinguishable from an empty install.
      migrations,
      latencyMs: Date.now() - began,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...(detail ? { detail } : {}),
    },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

function isTrusted(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
