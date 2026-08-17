import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Server-Sent Events stream for chat.
 *
 * WHY SSE. The brief allows Pusher/Ably, Socket.io or Postgres LISTEN/NOTIFY.
 * Socket.io needs a persistent Node server, which fights the Next.js hosting
 * the brief specifies. LISTEN/NOTIFY needs a dedicated long-lived connection
 * per subscriber and breaks under connection pooling. Pusher/Ably work but add
 * a vendor, a per-tenant configuration and a bill.
 *
 * SSE is native to a route handler, needs no infrastructure, reconnects on its
 * own, and is one-way server→client — which is exactly chat's shape, because
 * sending goes over POST anyway.
 *
 * It tails the database on an interval rather than being pushed to. That is a
 * deliberate MVP trade: it costs one cheap indexed query per client per tick
 * and is honest about what it is. At the point where that query load matters,
 * the fix is to swap this one file for an Ably channel — the client contract
 * (named events over EventSource) does not change.
 */

const TICK_MS = 2000
/** Serverless platforms cap function duration; the client reconnects, so
 *  closing cleanly before being killed keeps the stream unbroken. */
const MAX_LIFETIME_MS = 55_000

type Row = Record<string, unknown>

export async function GET(request: Request): Promise<Response> {
  const { ctx } = await getSession()
  if (!ctx) return new Response('Unauthorized', { status: 401 })

  const handle = await db()
  const encoder = new TextEncoder()

  /**
   * Cursor by message ID, not timestamp.
   *
   * Postgres now() is transaction-start time, so several messages written in
   * one transaction share a created_at — a `created_at > since` cursor would
   * silently skip all but the last of them. Ids are UUIDv7 and therefore
   * time-sortable, which makes an id cursor both exact and chronological.
   *
   * Seeded with the newest existing id so a reconnect does not replay history.
   */
  let sinceMessageId = '00000000-0000-0000-0000-000000000000'
  let sinceNotifiedAt = new Date().toISOString()
  const startedAt = Date.now()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // Tell the client how long to wait before reconnecting, and open with a
      // comment so proxies flush the connection immediately.
      controller.enqueue(encoder.encode(`retry: 3000\n: connected\n\n`))

      // Establish the starting cursor before the first tick, so a reconnect
      // resumes rather than replaying every message in the tenant.
      try {
        await withTenant(
          handle,
          { organizationId: ctx.organizationId, userId: ctx.userId },
          async (tx) => {
            const res = (await tx.execute(sql`
              select coalesce(max(m.id)::text, '00000000-0000-0000-0000-000000000000') as id
                from messages m
                join channel_members cm
                  on cm.channel_id = m.channel_id and cm.user_id = ${ctx.userId}
               where m.organization_id = ${ctx.organizationId}
            `)) as unknown as { rows: { id: string }[] }
            sinceMessageId = res.rows[0]!.id
          },
        )
      } catch {
        /* fall back to replaying from the beginning of the stream */
      }

      const tick = async () => {
        if (closed) return
        try {
          const payload = await withTenant(
            handle,
            { organizationId: ctx.organizationId, userId: ctx.userId },
            async (tx) => {
              // Only channels this user belongs to. A stream that leaked a
              // channel they cannot open would be a disclosure.
              const messages = (
                (await tx.execute(sql`
                  select m.id, m.channel_id as "channelId", m.body,
                         m.user_id as "userId", u.name as "authorName",
                         m.created_at as "createdAt"
                    from messages m
                    join channel_members cm
                      on cm.channel_id = m.channel_id and cm.user_id = ${ctx.userId}
                    left join users u on u.id = m.user_id
                   where m.organization_id = ${ctx.organizationId}
                     and m.id > ${sinceMessageId}::uuid
                     and m.deleted_at is null
                   order by m.id
                   limit 100
                `)) as unknown as { rows: Row[] }
              ).rows

              const notifications = (
                (await tx.execute(sql`
                  select id, type, title, body, href, created_at as "createdAt"
                    from notifications
                   where organization_id = ${ctx.organizationId}
                     and user_id = ${ctx.userId}
                     and read_at is null
                     and created_at > ${sinceNotifiedAt}
                   order by created_at
                   limit 20
                `)) as unknown as { rows: Row[] }
              ).rows

              return { messages, notifications }
            },
          )

          if (payload.messages.length > 0) {
            sinceMessageId = String(payload.messages[payload.messages.length - 1]!.id)
            send('messages', payload.messages)
          }
          if (payload.notifications.length > 0) {
            sinceNotifiedAt = String(
              payload.notifications[payload.notifications.length - 1]!.createdAt,
            )
            send('notifications', payload.notifications)
          }
        } catch {
          // A transient database error must not kill the stream; the next tick
          // retries and the client never notices.
        }
      }

      const interval = setInterval(() => {
        void tick()
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          closed = true
          clearInterval(interval)
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
      }, TICK_MS)

      request.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and similar buffer streamed responses by default, which makes an
      // SSE stream arrive all at once at the end — i.e. not a stream.
      'x-accel-buffering': 'no',
    },
  })
}
